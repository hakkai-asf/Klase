import { BODY_LABELS, BODIES, WEARABLE_LABELS, WEARABLES, normalizeLook, type BodyId, type Look, type WearableSlot } from "@klase/shared";
import { createLiveAvatarPreview, paintBodyPortrait, preloadAvatars } from "./game/avatar";

export type LookPickerHandle = {
  getLook: () => Look;
  setLook: (look: Look) => void;
  dispose: () => void;
  rightPanel: HTMLElement;
};

export type LookPickerOptions = {
  look: Look;
  /** Landing keeps hat/top/accessory as Coming Soon. Admin enables the same WEARABLES lists. */
  enableWearables: boolean;
  persistLook?: boolean;
  onChange?: (look: Look) => void;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

const LOOK_KEY = "klase-look";

function persist(look: Look, enabled: boolean) {
  if (!enabled) return;
  localStorage.setItem(LOOK_KEY, JSON.stringify(look));
}

/**
 * Shared body / wearable grid + live 3D preview.
 * Options always come from BODIES / WEARABLES in @klase/shared.
 */
export function mountLookPicker(host: HTMLElement, opts: LookPickerOptions): LookPickerHandle {
  let currentLook = normalizeLook(opts.look);
  const persistLook = opts.persistLook === true;

  const pickerBody = el("div", "neo-picker-body");
  const leftCol = el("div", "neo-picker-left");
  const tabsBar = el("div", "neo-picker-tabs");
  type CategoryTab = "body" | WearableSlot;
  let activeTab: CategoryTab = "body";

  const tabItems: Array<{ id: CategoryTab; label: string; disabled?: boolean }> = [
    { id: "body", label: "Characters" },
    { id: "hat", label: "Hats", disabled: !opts.enableWearables },
    { id: "top", label: "Tops", disabled: !opts.enableWearables },
    { id: "accessory", label: "Accs", disabled: !opts.enableWearables },
  ];

  const tabBtnsMap = new Map<CategoryTab, HTMLButtonElement>();
  tabItems.forEach((tab) => {
    const classes = `neo-tab-btn${activeTab === tab.id ? " active" : ""}${tab.disabled ? " disabled" : ""}`;
    const tBtn = el("button", classes) as HTMLButtonElement;
    tBtn.type = "button";
    tBtn.append(document.createTextNode(tab.label));
    if (tab.disabled) {
      tBtn.disabled = true;
      tBtn.append(el("span", "neo-tab-soon", "Soon"));
    } else {
      tBtn.addEventListener("click", () => {
        activeTab = tab.id;
        tabBtnsMap.forEach((b, k) => b.classList.toggle("active", k === activeTab));
        renderCardGrid();
      });
    }
    tabBtnsMap.set(tab.id, tBtn);
    tabsBar.append(tBtn);
  });
  leftCol.append(tabsBar);

  const cardsGridContainer = el("div", "neo-picker-grid-container");
  leftCol.append(cardsGridContainer);

  const portraits = new Map<BodyId, HTMLImageElement>();
  let updateRightPanelSummary: () => void = () => {};
  let livePreviewHandle: ReturnType<typeof createLiveAvatarPreview> | null = null;
  let portraitStops: Array<() => void> = [];

  const paintPortraits = () => {
    for (const stop of portraitStops) stop();
    portraitStops = [];
    void preloadAvatars()
      .then(() => {
        if (!cardsGridContainer.isConnected) return;
        portraitStops = BODIES.filter((id) => portraits.has(id)).map((id) =>
          paintBodyPortrait(portraits.get(id)!, id),
        );
      })
      .catch((e) => console.warn("Character preview failed", e));
  };

  const applyLook = (next: Look, renderGrid = true) => {
    currentLook = normalizeLook(next);
    persist(currentLook, persistLook);
    if (renderGrid) renderCardGrid();
    livePreviewHandle?.updateLook(currentLook);
    updateRightPanelSummary();
    opts.onChange?.(currentLook);
  };

  const addWearableCards = (slot: WearableSlot, heading: string) => {
    const h = el("div", "neo-grid-heading", opts.enableWearables ? heading : `${heading} (Coming Soon)`);
    const grid = cardsGridContainer.querySelector(".neo-picker-grid")!;
    grid.append(h);
    for (const id of WEARABLES[slot]) {
      const selected = currentLook[slot] === id;
      const card = el(
        "button",
        `neo-char-card${opts.enableWearables && selected ? " active" : ""}${opts.enableWearables ? "" : " disabled"}`,
      ) as HTMLButtonElement;
      card.type = "button";
      card.disabled = !opts.enableWearables;
      const info = el("div", "neo-char-card-info");
      info.append(
        el("span", "neo-char-card-name", WEARABLE_LABELS[id] || id || "None"),
        opts.enableWearables
          ? el("span", "neo-char-card-tag", heading.replace(/s$/, ""))
          : el("span", "neo-char-card-soon-tag", "Coming Soon"),
      );
      card.append(info);
      if (opts.enableWearables) {
        card.addEventListener("click", () => {
          applyLook({ ...currentLook, [slot]: id });
        });
      }
      grid.append(card);
    }
  };

  const renderCardGrid = () => {
    const prevScrollLeft = cardsGridContainer.scrollLeft;
    const prevScrollTop = cardsGridContainer.scrollTop;
    cardsGridContainer.innerHTML = "";
    portraits.clear();
    const grid = el("div", "neo-picker-grid");
    cardsGridContainer.append(grid);

    if (activeTab === "body") {
      grid.append(el("div", "neo-grid-heading", "Characters"));
      for (const id of BODIES) {
        const card = el("button", `neo-char-card${currentLook.body === id ? " active" : ""}`) as HTMLButtonElement;
        card.type = "button";
        const thumb = el("div", "neo-char-card-thumb");
        const img = el("img") as HTMLImageElement;
        img.alt = BODY_LABELS[id];
        thumb.append(img);
        portraits.set(id, img);
        const info = el("div", "neo-char-card-info");
        info.append(el("span", "neo-char-card-name", BODY_LABELS[id]), el("span", "neo-char-card-tag", "Character"));
        card.append(thumb, info, el("div", "neo-char-card-check", "✓"));
        card.addEventListener("click", () => applyLook({ ...currentLook, body: id }));
        grid.append(card);
      }
    } else {
      const labels: Record<WearableSlot, string> = { hat: "Hats", top: "Tops", accessory: "Accessories" };
      addWearableCards(activeTab, labels[activeTab]);
    }

    cardsGridContainer.scrollLeft = prevScrollLeft;
    cardsGridContainer.scrollTop = prevScrollTop;
    paintPortraits();
  };

  const centerCol = el("div", "neo-picker-center");
  const centerView = el("div", "neo-char-center-view");
  centerView.append(el("div", "neo-center-hint", "Drag to rotate avatar"));
  centerCol.append(centerView);

  void preloadAvatars().then(() => {
    if (!centerView.isConnected) return;
    livePreviewHandle = createLiveAvatarPreview(centerView, currentLook);
  });

  const rightCol = el("div", "neo-picker-right");
  const summaryCard = el("div", "neo-summary-card");
  const avatarTitle = el("h3", "neo-summary-title", BODY_LABELS[currentLook.body]);
  const avatarTags = el("div", "neo-summary-tags");
  updateRightPanelSummary = () => {
    avatarTitle.textContent = BODY_LABELS[currentLook.body];
    avatarTags.innerHTML = "";
    const items = [
      WEARABLE_LABELS[currentLook.top],
      WEARABLE_LABELS[currentLook.hat],
      WEARABLE_LABELS[currentLook.accessory],
    ].filter((x) => x && x !== "None");
    if (items.length === 0) avatarTags.append(el("span", "neo-pill-tag", "Default Outfit"));
    else items.forEach((item) => avatarTags.append(el("span", "neo-pill-tag", item)));
  };
  updateRightPanelSummary();
  summaryCard.append(
    el("div", "neo-summary-badge", "SELECTED AVATAR"),
    avatarTitle,
    avatarTags,
    el("p", "neo-summary-desc", "Customizable student avatar for proximity voice chat and classroom exploration."),
  );
  rightCol.append(summaryCard);

  pickerBody.append(leftCol, centerCol, rightCol);
  host.append(pickerBody);
  renderCardGrid();

  return {
    getLook: () => normalizeLook(currentLook),
    setLook: (look) => applyLook(look),
    dispose: () => {
      for (const stop of portraitStops) stop();
      portraitStops = [];
      livePreviewHandle?.dispose();
      livePreviewHandle = null;
      pickerBody.remove();
    },
    rightPanel: rightCol,
  };
}
