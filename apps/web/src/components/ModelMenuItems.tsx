import { useT } from "../lib/i18n";
import type { ProviderModel } from "../lib/models";

type Props = {
  models: ProviderModel[];
  /** current "provider/model" selection ("" = daemon default) */
  model: string;
  /** persist the pick (both composers write the same ocr_model key) */
  onPick: (value: string) => void;
};

/** P2-123: the model section of the composer dropdown, shared by the ChatView
 * selector and the home selector — the item markup cannot drift apart. */
export default function ModelMenuItems({ models, model, onPick }: Props) {
  const t = useT();
  return (
    <>
      <div className="composer-menu-head">{t("model")}</div>
      <button
        role="option"
        aria-selected={!model}
        data-model=""
        className={`composer-menu-item${!model ? " selected" : ""}`}
        onClick={() => onPick("")}
      >
        {t("defaultModel")}
      </button>
      {models.map((m) => (
        <button
          key={`${m.providerID}/${m.modelID}`}
          role="option"
          aria-selected={model === `${m.providerID}/${m.modelID}`}
          data-model={`${m.providerID}/${m.modelID}`}
          className={`composer-menu-item${model === `${m.providerID}/${m.modelID}` ? " selected" : ""}`}
          onClick={() => onPick(`${m.providerID}/${m.modelID}`)}
        >
          {m.name}
        </button>
      ))}
    </>
  );
}
