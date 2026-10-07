import {
  MOD_DURATIONS,
  MOD_MESSAGE_MAX,
  MOD_REASONS,
  clockRemain,
  humanRemain,
  type ModerationNotice,
} from "@klase/shared";
import { ICONS } from "./ui";

export type ModTarget = {
  id: string;
  name: string;
  role: string;
  serverMuted?: boolean;
  observer?: boolean;
};

export type ModAction = "kick" | "ban" | "mute" | "unmute" | "message" | "promote" | "demote" | "announce";

export type ModSubmit = {
  action: ModAction;
  targetIds: string[];
  reason: string;
  message: string;
  cooldownSec: number;
  permanent: boolean;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function typing(t: EventTarget | null) {
  const n = t as HTMLElement | null;
  return Boolean(n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT"));
}

export function parseHeld(raw: string): ModerationNotice | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start)) as { error?: string; notice?: ModerationNotice };
    if (parsed.error === "HELD" && parsed.notice) return parsed.notice;
  } catch {
    return null;
  }
  return null;
}

export function renderModerationNotice(root: HTMLElement, notice: ModerationNotice, onBack?: () => void) {
  root.innerHTML = "";
  const wrap = el("div", "landing");
  const card = el("div", "clay mod-notice");
  const who = notice.actorRole === "admin" ? "Admin" : "Owner";
  const verb = notice.kind === "ban" ? "banned" : "kicked";
  card.append(el("h2", "", `You have been ${verb} by ${who} ${notice.actorName}`));
  if (notice.reason) {
    const r = el("p", "");
    r.append(el("strong", "", "Reason: "), document.createTextNode(notice.reason));
    card.append(r);
  }
  if (notice.message) {
    const m = el("p", "");
    m.append(el("strong", "", "Message: "), document.createTextNode(notice.message));
    card.append(m);
  }
  const last = el("p", "mod-notice-time");
  card.append(last);
  const tick = () => {
    if (!last.isConnected) return;
    if (notice.kind === "ban" && notice.until === null) {
      last.textContent = "This ban does not expire";
      return;
    }
    const left = (notice.until ?? 0) - Date.now();
    if (notice.kind === "ban") {
      last.textContent = left > 0 ? `This ban expires in ${humanRemain(left)}` : "This ban has expired";
    } else {
      last.textContent = left > 0 ? `You can rejoin in ${clockRemain(left)}` : "You can rejoin now";
    }
    window.setTimeout(tick, 1000);
  };
  tick();
  if (onBack) {
    const b = el("button", "clay-btn primary", "Back");
    b.addEventListener("click", onBack);
    card.append(b);
  }
  wrap.append(card);
  root.append(wrap);
}

function previewText(
  action: ModAction,
  actorRole: string,
  actorName: string,
  reason: string,
  message: string,
  cooldownSec: number,
  permanent: boolean,
  count: number,
) {
  const who = actorRole === "admin" ? "Admin" : "Owner";
  if (action === "message" || action === "announce") return message || "(no message)";
  if (action === "mute") return `${count} player${count === 1 ? "" : "s"} will be muted.`;
  if (action === "unmute") return `${count} player${count === 1 ? "" : "s"} will be unmuted.`;
  if (action === "promote") return `${count} player${count === 1 ? "" : "s"} will become admin.`;
  if (action === "demote") return `${count} player${count === 1 ? "" : "s"} will become user.`;
  const verb = action === "ban" ? "banned" : "kicked";
  const lines = [`You have been ${verb} by ${who} ${actorName}`];
  if (reason) lines.push(`Reason: ${reason}`);
  if (message) lines.push(`Message: ${message}`);
  if (action === "ban" && permanent) lines.push("This ban does not expire");
  else if (action === "ban") lines.push(`This ban expires in ${humanRemain(cooldownSec * 1000)}`);
  else if (cooldownSec > 0) lines.push(`You can rejoin in ${clockRemain(cooldownSec * 1000)}`);
  return lines.join("\n");
}

export function openModerationModal(opts: {
  action: ModAction;
  actorRole: string;
  actorName: string;
  players: ModTarget[];
  preselected?: string[];
  onSubmit: (payload: ModSubmit) => void;
}) {
  const overlay = el("div", "mod-overlay");
  const card = el("div", "clay mod-modal");
  overlay.append(card);
  const titles: Record<ModAction, string> = {
    kick: "Kick",
    ban: "Ban",
    mute: "Mute",
    unmute: "Unmute",
    message: "Message",
    promote: "Promote to admin",
    demote: "Demote to user",
    announce: "Announce",
  };
  card.append(el("h2", "", titles[opts.action]));

  const needsTargets = opts.action !== "announce";
  const needsReason = opts.action === "kick" || opts.action === "ban";
  const needsMessage = opts.action === "kick" || opts.action === "ban" || opts.action === "message" || opts.action === "announce";
  const needsDuration = opts.action === "kick" || opts.action === "ban";

  const selected = new Set(opts.preselected ?? []);
  const search = el("input", "clay-input") as HTMLInputElement;
  search.placeholder = "Search players";
  const list = el("div", "mod-targets");
  const paintTargets = () => {
    list.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    const rows = opts.players.filter((p) => !p.observer && (!q || p.name.toLowerCase().includes(q) || p.role.includes(q)));
    if (!rows.length) list.append(el("p", "admin-empty", "No matching players."));
    for (const p of rows) {
      const row = el("label", "mod-target");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(p.id);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(p.id);
        else selected.delete(p.id);
        refresh();
      });
      row.append(box, document.createTextNode(` ${p.name} `));
      if (p.role !== "user") row.append(el("span", `badge ${p.role}`, p.role));
      if (p.serverMuted) row.append(el("span", "badge", "muted"));
      list.append(row);
    }
  };
  if (needsTargets) {
    card.append(el("label", "", "Target"));
    const tools = el("div", "mod-target-tools");
    const all = el("button", "clay-btn", "Select all in room") as HTMLButtonElement;
    all.type = "button";
    all.addEventListener("click", () => {
      for (const p of opts.players) {
        if (p.observer || p.role === "owner") continue;
        selected.add(p.id);
      }
      paintTargets();
      refresh();
    });
    tools.append(all);
    card.append(search, tools, list);
    search.addEventListener("input", paintTargets);
    paintTargets();
  }

  let reason: (typeof MOD_REASONS)[number] = MOD_REASONS[0];
  let other = "";
  if (needsReason) {
    card.append(el("label", "", "Reason"));
    const sel = document.createElement("select");
    sel.className = "clay-input";
    for (const r of MOD_REASONS) {
      const o = document.createElement("option");
      o.value = r;
      o.textContent = r;
      sel.append(o);
    }
    const otherBox = el("input", "clay-input") as HTMLInputElement;
    otherBox.placeholder = "Describe the reason";
    otherBox.hidden = true;
    sel.addEventListener("change", () => {
      reason = sel.value as typeof MOD_REASONS[number];
      otherBox.hidden = reason !== "Other";
      refresh();
    });
    otherBox.addEventListener("input", () => {
      other = otherBox.value;
      refresh();
    });
    card.append(sel, otherBox);
  }

  const msg = document.createElement("textarea");
  msg.className = "clay-input";
  msg.maxLength = MOD_MESSAGE_MAX;
  msg.rows = 3;
  msg.placeholder = "Message to the player (optional)";
  const counter = el("div", "mod-count", `0 / ${MOD_MESSAGE_MAX}`);
  if (needsMessage) {
    card.append(el("label", "", opts.action === "announce" || opts.action === "message" ? "Message" : "Message to the player"));
    card.append(msg, counter);
    msg.addEventListener("input", refresh);
  }

  let cooldownSec = MOD_DURATIONS[0].sec;
  let permanent = false;
  if (needsDuration) {
    card.append(el("label", "", "Duration"));
    const chips = el("div", "mod-chips");
    const custom = el("div", "mod-custom");
    const num = el("input", "clay-input") as HTMLInputElement;
    num.type = "number";
    num.min = "1";
    num.value = "5";
    const unit = document.createElement("select");
    unit.className = "clay-input";
    for (const [label, sec] of [["minutes", 60], ["hours", 3600], ["days", 86400]] as const) {
      const o = document.createElement("option");
      o.value = String(sec);
      o.textContent = label;
      unit.append(o);
    }
    const mark = () => {
      chips.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("primary", (b as HTMLButtonElement).dataset.sec === String(permanent ? -1 : cooldownSec));
      });
    };
    const setDur = (sec: number, perm: boolean) => {
      cooldownSec = sec;
      permanent = perm;
      mark();
      refresh();
    };
    for (const d of MOD_DURATIONS) {
      const b = el("button", "clay-btn", d.label) as HTMLButtonElement;
      b.type = "button";
      b.dataset.sec = String(d.sec);
      b.addEventListener("click", () => setDur(d.sec, false));
      chips.append(b);
    }
    if (opts.action === "ban") {
      const b = el("button", "clay-btn warn", "Permanent") as HTMLButtonElement;
      b.type = "button";
      b.dataset.sec = "-1";
      b.addEventListener("click", () => setDur(0, true));
      chips.append(b);
    }
    const applyCustom = () => {
      const n = Math.max(1, Number(num.value) || 1);
      setDur(n * Number(unit.value), false);
    };
    num.addEventListener("input", applyCustom);
    unit.addEventListener("change", applyCustom);
    custom.append(num, unit);
    card.append(chips, custom);
    mark();
  }

  const preview = el("pre", "mod-preview");
  card.append(el("label", "", "They will see"), preview);

  const actions = el("div", "mod-actions");
  const cancel = el("button", "clay-btn", "Cancel") as HTMLButtonElement;
  const confirm = el("button", "clay-btn warn", "Confirm") as HTMLButtonElement;
  actions.append(cancel, confirm);
  card.append(actions);

  const resolvedReason = () => (reason === "Other" ? other.trim().slice(0, 80) : reason);

  function refresh() {
    const n = needsTargets ? selected.size : 1;
    counter.textContent = `${msg.value.length} / ${MOD_MESSAGE_MAX}`;
    preview.textContent = previewText(
      opts.action,
      opts.actorRole,
      opts.actorName,
      resolvedReason(),
      msg.value.trim(),
      cooldownSec,
      permanent,
      n,
    );
    const label = titles[opts.action];
    confirm.textContent = needsTargets ? `${label} ${n} player${n === 1 ? "" : "s"}` : label;
    confirm.disabled = (needsTargets && n < 1) || (needsReason && reason === "Other" && !other.trim()) || ((opts.action === "message" || opts.action === "announce") && !msg.value.trim());
  }

  const close = () => overlay.remove();
  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  confirm.addEventListener("click", () => {
    if (confirm.disabled) return;
    opts.onSubmit({
      action: opts.action,
      targetIds: [...selected],
      reason: resolvedReason(),
      message: msg.value.trim().slice(0, MOD_MESSAGE_MAX),
      cooldownSec: permanent ? 0 : cooldownSec,
      permanent,
    });
    close();
  });
  document.body.append(overlay);
  refresh();
  search.focus();
}

export function renderModerationToolbar(
  host: HTMLElement,
  opts: {
    role: string;
    actorName: string;
    getPlayers: () => ModTarget[];
    onSubmit: (payload: ModSubmit) => void;
  },
) {
  host.innerHTML = "";
  const row = el("div", "mod-toolbar");
  const open = (action: ModAction, pre?: string[]) => {
    openModerationModal({
      action,
      actorRole: opts.role,
      actorName: opts.actorName,
      players: opts.getPlayers(),
      preselected: pre,
      onSubmit: opts.onSubmit,
    });
  };
  const add = (label: string, action: ModAction, warn = false, preAll = false) => {
    const b = el("button", warn ? "clay-btn warn" : "clay-btn", label);
    b.addEventListener("click", () => {
      const players = opts.getPlayers().filter((p) => !p.observer && p.role !== "owner");
      open(action, preAll ? players.filter((p) => p.role === "user").map((p) => p.id) : undefined);
    });
    row.append(b);
  };
  add("Kick", "kick", true);
  add("Ban", "ban", true);
  add("Mute", "mute");
  add("Unmute", "unmute");
  add("Message", "message");
  if (opts.role === "owner") {
    add("Promote", "promote");
    add("Demote", "demote");
  }
  add("Kick all", "kick", true, true);
  const ann = el("button", "clay-btn primary", "Announce");
  ann.addEventListener("click", () => open("announce"));
  row.append(ann);
  host.append(row);
}

export function bindPanelHotkeys(isOpen: () => boolean, close: () => void, toggle: () => void) {
  const onKey = (e: KeyboardEvent) => {
    if (typing(e.target)) {
      if (e.key === "Escape" && isOpen()) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      close();
      return;
    }
    if (document.querySelector(".mod-overlay")) return;
    if (e.key.toLowerCase() === "g" && !e.repeat) {
      e.preventDefault();
      if (isOpen()) close();
      else toggle();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
