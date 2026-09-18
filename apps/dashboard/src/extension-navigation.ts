import type { BusinessPage, ExtensionBusinessPanel } from "@linmu/dsh-session-contracts";

export interface ExtensionCategory {
  id: string;
  label: string;
  adapterId?: string;
  pages: BusinessPage[];
}

// Older Bridge registrations have no data-directory section and own no stored
// namespace. Keep this one compatibility association explicit; other providers
// are grouped using their registration and adapter member metadata.
const legacyProviderAdapters: Record<string, { id: string; label: string }> = {
  "obsidian-bridge": { id: "obsidian-series", label: "Obsidian Bridge" },
};

function categoryLabel(id: string, fallback: string): string {
  if (id === 'obsidian-series') return 'Obsidian Bridge';
  if (id === 'gpt-compat' || id === 'namespace:gpt-compat') return 'GPT 兼容插件';
  if (id === 'thoughtdag' || id === 'namespace:thoughtdag') return 'ThoughtDAG';
  return fallback;
}

export function extensionCategories(panels: ExtensionBusinessPanel[], pages: BusinessPage[]): ExtensionCategory[] {
  const categories = new Map<string, ExtensionCategory>();
  for (const panel of panels) {
    if (!categories.has(panel.adapterId)) categories.set(panel.adapterId, { id: panel.adapterId, label: categoryLabel(panel.adapterId, panel.label), adapterId: panel.adapterId, pages: [] });
  }
  for (const page of pages) {
    const directory = page.snapshot.sections.find(section => section.kind === "data-directory");
    const member = panels.find(panel => panel.scope.instanceId === page.owner.instanceId && panel.scope.profileId === page.owner.profileId && panel.members.some(item => item.scope.namespace === page.owner.namespace));
    const legacy = legacyProviderAdapters[page.owner.namespace];
    const adapterId = directory?.kind === "data-directory" ? directory.adapterId : member?.adapterId ?? legacy?.id;
    const id = adapterId ?? `provider:${page.owner.namespace}`;
    const category = categories.get(id) ?? { id, label: legacy?.label ?? page.snapshot.title, ...(adapterId ? { adapterId } : {}), pages: [] };
    category.pages.push(page);
    categories.set(id, category);
  }
  return [...categories.values()];
}

/** One navigation entry per registered provider; instances share that entry. */
export function extensionRegisteredViews(pages: BusinessPage[]) {
  const views = new Map<string, { id: string; label: string; pages: BusinessPage[] }>();
  for (const page of pages) {
    const id = JSON.stringify([page.owner.namespace, page.owner.providerId]);
    const view = views.get(id) ?? { id, label: page.owner.namespace === "obsidian-bridge" ? "Vault 绑定" : page.snapshot.title, pages: [] };
    view.pages.push(page);
    views.set(id, view);
  }
  return [...views.values()];
}
