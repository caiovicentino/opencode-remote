// P2-123: /provider model list + ocr_model persistence shared by the ChatView
// composer and the home composer — one source of truth so the two selectors
// cannot drift.
import { useEffect, useState } from "react";

export interface ProviderModel {
  providerID: string;
  modelID: string;
  name: string;
}

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown }>;

export function useModelSelector(request: RequestFn) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [model, setModel] = useState(localStorage.getItem("ocr_model") ?? "");

  // model list, same endpoint ChatView's selector always used (best effort).
  // Fetch once on mount: App.request is recreated per render, a [request] dep
  // would refetch every render.
  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", "/provider");
        const all = (res.body as { all?: { id: string; models?: Record<string, { id: string; name?: string }> }[] })
          .all ?? [];
        const flat = all.flatMap((p) =>
          Object.values(p.models ?? {}).map((m) => ({
            providerID: p.id,
            modelID: m.id,
            name: `${p.id} · ${m.name ?? m.id}`,
          })),
        );
        setModels(flat);
      } catch {
        // model list is optional
      }
    })();
  }, []);

  function pickModel(value: string) {
    setModel(value);
    localStorage.setItem("ocr_model", value);
  }

  return { models, model, pickModel };
}
