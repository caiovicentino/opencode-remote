/**
 * P2-245 — the winget manifest contract for the release workflow.
 *
 * docs/VISION.md stage 5 hands a Windows user nothing but a loose setup exe
 * on a releases page, while the Mac leaves the same pipeline with a Homebrew
 * formula whose sha256 is pinned automatically: no reproducible install
 * path, no declared version, and nothing proving a published manifest
 * actually points at the right file — the silent-drift class of error P2-212
 * closed for the update feeds and P2-216 closed for the download guide.
 * This module is the deterministic half of that fix (the release.yml step
 * wires the I/O):
 *
 *   - buildWingetManifests(...) → the ordered list of the three documents
 *     winget requires (version, installer, default locale), each as a file
 *     name plus its text, generated from the documented package identifier,
 *     the release version, the published installer URL and the sha256 the
 *     checksum job already computed. Fail-closed: an empty or malformed
 *     version, a non-https URL, a URL outside this project's own releases
 *     page and a hash that is not exactly 64 hex digits are refused, never
 *     published.
 *   - wingetProblems(...)       → everything wrong with a generated manifest
 *     set against the release facts, in the same plain string[] format as
 *     scripts/portablecoverage.ts and scripts/release-checksums.ts: one
 *     problem per cause, rules applied in a fixed order with no
 *     short-circuit, every text one sentence naming what to do.
 *
 * Pure by construction: no fs, no child process, no network — the caller
 * reads the real-world inputs (the tag, the published asset list, the
 * checksums.txt text) and injects them, so the unit battery can pin every
 * branch with synthetic fixtures and the real-repo assertion in
 * scripts/unit.test.ts pins the workflow wiring.
 */

/** The winget package identifier documented in README/README.pt-BR/docs. */
export const WINGET_PACKAGE_ID = "caiovicentino.opencode-remote";

/** The only place an installer URL may live: this project's own releases. */
export const WINGET_RELEASES_BASE =
  "https://github.com/caiovicentino/opencode-remote/releases/download/";

/** The default-locale document winget requires, and the locale it carries. */
export const WINGET_DEFAULT_LOCALE = "en-US";

/** One generated manifest: its flat file name and its full text. */
export interface WingetManifestDoc {
  fileName: string;
  text: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const PACKAGE_ID_RE = /^\S+\.\S+$/;

function refuse(ok: boolean, message: string): void {
  if (!ok) throw new Error(`winget-manifests: ${message}`);
}

/**
 * The three winget manifest documents for a release, sorted by file name
 * (installer, locale, version — byte-wise, so the order is stable). Throws
 * on any input a published manifest must never carry: an empty or
 * non-semver version, a non-https installer URL, a URL outside the
 * project's own releases page, a hash that is not exactly 64 hex digits,
 * or a package identifier without the Publisher.Name shape.
 */
export function buildWingetManifests(
  packageId: string,
  version: string,
  installerUrl: string,
  sha256: string,
): WingetManifestDoc[] {
  refuse(packageId.length > 0, "the package identifier is empty — pass the documented one");
  refuse(
    PACKAGE_ID_RE.test(packageId),
    `package identifier "${packageId}" lacks the Publisher.Name shape — use ${WINGET_PACKAGE_ID}`,
  );
  refuse(version.length > 0, "the version is empty — pass the bare semver of the release tag");
  refuse(
    VERSION_RE.test(version),
    `version "${version}" is not a semver x.y.z — derive it from the release tag`,
  );
  let url: URL;
  try {
    url = new URL(installerUrl);
  } catch {
    throw new Error("winget-manifests: the installer address is not a URL at all");
  }
  refuse(
    url.protocol === "https:",
    "the installer address is not https — a manifest may only point at an encrypted download",
  );
  refuse(
    url.href.startsWith(WINGET_RELEASES_BASE),
    "the installer address does not point at this project's own releases page — a manifest must never redirect the install elsewhere",
  );
  refuse(
    SHA256_RE.test(sha256),
    "the installer sha256 is not exactly 64 hex digits — pass the digest the checksum job computed",
  );

  const versionDoc: WingetManifestDoc = {
    fileName: `${packageId}.yaml`,
    text: [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.4.0.schema.json",
      `PackageIdentifier: ${packageId}`,
      `PackageVersion: ${version}`,
      `DefaultLocale: ${WINGET_DEFAULT_LOCALE}`,
      "ManifestType: version",
      "ManifestVersion: 1.4.0",
      "",
    ].join("\n"),
  };
  const installerDoc: WingetManifestDoc = {
    fileName: `${packageId}.installer.yaml`,
    text: [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.4.0.schema.json",
      `PackageIdentifier: ${packageId}`,
      `PackageVersion: ${version}`,
      "Installers:",
      "  - Architecture: x64",
      "    InstallerType: nsis",
      `    InstallerUrl: ${installerUrl}`,
      `    InstallerSha256: ${sha256.toLowerCase()}`,
      "ManifestType: installer",
      "ManifestVersion: 1.4.0",
      "",
    ].join("\n"),
  };
  const localeDoc: WingetManifestDoc = {
    fileName: `${packageId}.locale.${WINGET_DEFAULT_LOCALE}.yaml`,
    text: [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.4.0.schema.json",
      `PackageIdentifier: ${packageId}`,
      `PackageVersion: ${version}`,
      `PackageLocale: ${WINGET_DEFAULT_LOCALE}`,
      "Publisher: Caio Vicentino",
      "PackageName: opencode-remote",
      "License: AGPL-3.0-only",
      "ShortDescription: Control opencode from your phone — E2E encrypted, blind relay",
      "ManifestType: defaultLocale",
      "ManifestVersion: 1.4.0",
      "",
    ].join("\n"),
  };
  return [installerDoc, localeDoc, versionDoc].sort((a, b) =>
    a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
  );
}

/** The bare version of a release tag — the leading v is optional (P2-151). */
function bareVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/** Package identifier declared by a manifest set — the common file-name prefix. */
function manifestPackageId(manifests: readonly WingetManifestDoc[]): string {
  const names = manifests.map((doc) => doc.fileName);
  const installer = names.find((name) => name.endsWith(".installer.yaml"));
  if (installer) return installer.slice(0, -".installer.yaml".length);
  const locale = names.find((name) => name.includes(".locale."));
  if (locale) return locale.slice(0, locale.indexOf(".locale."));
  const version = names.find((name) => name.endsWith(".yaml"));
  return version ? version.slice(0, -".yaml".length) : "";
}

function manifestField(doc: WingetManifestDoc | undefined, field: string): string {
  if (!doc) return "";
  const match = doc.text.match(new RegExp(`^[ \\t]*${field}:[ \\t]*(\\S+)`, "m"));
  return match ? match[1]! : "";
}

/** The asset name an installer URL points at, decoded (GitHub names may carry spaces). */
function urlAssetName(url: string): string {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").pop() ?? "";
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    return "";
  }
}

/** The `<hash>  <name>` line of checksums.txt for one asset, or "". */
function checksumLine(checksumsText: string, assetName: string): string {
  return (
    checksumsText
      .split(/\r?\n/)
      .find((line) => line.endsWith(`  ${assetName}`)) ?? ""
  );
}

/**
 * Every problem with a generated manifest set against the release facts,
 * all at once, in the portablecoverage string[] format. Rules applied in
 * this fixed order, one problem per cause, no short-circuit:
 *   1. the declared version differs from the release tag;
 *   2. the installer address points at an asset absent from the release;
 *   3. the declared sha256 differs from the sum in the attached
 *      checksums.txt (or the manifest is not there to confirm it);
 *   4. the package identifier differs from the documented one.
 * An empty manifest list has nothing to verify and returns zero problems —
 * the workflow always builds first, and buildWingetManifests refuses bad
 * input before this function ever runs. The order is stable for the same
 * input, and no problem text carries an absolute file path or a secret.
 */
export function wingetProblems(
  manifests: readonly WingetManifestDoc[],
  tag: string,
  assetNames: readonly string[],
  checksumsText: string,
): string[] {
  if (manifests.length === 0) return [];
  const problems: string[] = [];
  const packageId = manifestPackageId(manifests);
  const versionDoc = manifests.find((doc) => doc.fileName === `${packageId}.yaml`);
  const installerDoc = manifests.find((doc) => doc.fileName === `${packageId}.installer.yaml`);

  const declaredVersion = manifestField(versionDoc, "PackageVersion");
  if (declaredVersion === "") {
    problems.push(
      "winget-manifests: the version manifest declares no PackageVersion — regenerate the manifests from the release tag so winget can pin the installed version",
    );
  } else if (declaredVersion !== bareVersion(tag)) {
    problems.push(
      `winget-manifests: the manifests declare version ${declaredVersion} but the release tag is ${tag} — regenerate the manifests from the tag before attaching them`,
    );
  }

  const installerUrl = manifestField(installerDoc, "InstallerUrl");
  const assetName = urlAssetName(installerUrl);
  if (installerUrl === "" || assetName === "") {
    problems.push(
      "winget-manifests: the installer manifest declares no usable InstallerUrl — regenerate the manifests so the manifest points at the published installer",
    );
  } else if (!assetNames.includes(assetName)) {
    problems.push(
      `winget-manifests: the installer address points at asset "${assetName}" which the release does not carry — regenerate the manifests after the installer asset is attached`,
    );
  }

  const declaredSha = manifestField(installerDoc, "InstallerSha256");
  const checksumLineText = assetName === "" ? "" : checksumLine(checksumsText, assetName);
  const publishedSha = checksumLineText.split("  ")[0] ?? "";
  if (declaredSha === "") {
    problems.push(
      "winget-manifests: the installer manifest declares no InstallerSha256 — regenerate the manifests from the digest the checksum job computed",
    );
  } else if (publishedSha === "" || publishedSha.toLowerCase() !== declaredSha.toLowerCase()) {
    problems.push(
      `winget-manifests: the manifests declare sha256 ${declaredSha} which checksums.txt does not confirm for ${assetName} — regenerate the manifests from the attached checksum manifest`,
    );
  }

  if (packageId !== WINGET_PACKAGE_ID) {
    problems.push(
      `winget-manifests: the manifests declare package identifier "${packageId}" but the documented one is ${WINGET_PACKAGE_ID} — regenerate the manifests with the documented identifier`,
    );
  }
  return problems;
}
