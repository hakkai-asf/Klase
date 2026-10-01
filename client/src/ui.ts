import { BODY_LABELS, BODIES, CHAT_LOG_MAX, WEARABLE_LABELS, WEARABLES, normalizeLook, type BodyId, type Look, type WearableSlot } from "@klase/shared";
import type { RemotePlayer } from "./net";
import { authEnabled } from "./auth";
import { paintBodyPortrait, preloadAvatars } from "./game/avatar";
import { isTouchUi } from "./joystick";
import gameMenuUrl from "../../assets/menu-screen/game-menu.png";
import howKlaseWorksTextUrl from "../../assets/menu-screen/how-klase-works-text.png";
import communityGuidelinesTextUrl from "../../assets/menu-screen/klase-community-guidelines-text.png";
import infoAndRulesTextUrl from "../../assets/menu-screen/klase-info-and-rules-text.png";
import loadingScreenUrl from "../../assets/menu-screen/loading-screen.png";
import blueLoadingData from "../../assets/menu-screen/blue-loading.json";

export type ChatLine = {
  from: string;
  name: string;
  text: string;
  kind: string;
};

export type JoinPayload = { name: string; look: Look; accessToken?: string };
export type JoinStage = "find" | "join" | "load" | "ready";

const JOIN_STAGE: Record<JoinStage, { cap: number; tau: number; copy: string[] }> = {
  find: {
    cap: 0.4,
    tau: 14,
    copy: [
      "Connecting you to a classroom…",
      "Waking the server — first join can take a minute.",
      "Finding you a room…",
    ],
  },
  join: {
    cap: 0.65,
    tau: 5,
    copy: ["Joining your classroom…", "Almost there…"],
  },
  load: {
    cap: 0.95,
    tau: 8,
    copy: ["Loading the classroom…", "Setting up desks and characters…"],
  },
  ready: {
    cap: 1,
    tau: 0.35,
    copy: ["You're in."],
  },
};

function menuBrand(lede: string) {
  const brand = el("div", "menu-brand");
  brand.append(el("h1", "", "Klase"), el("p", "lede", lede));
  return brand;
}

export function renderJoining(root: HTMLElement) {
  disposeLandingPreviews();
  root.innerHTML = "";

  const wrap = el("div", "onboarding-wrap");
  wrap.style.position = "absolute";
  wrap.style.inset = "0";
  wrap.style.zIndex = "999";
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.background = "#f4ece2";

  const box = el("div", "loading-box");
  box.style.display = "flex";
  box.style.flexDirection = "column";
  box.style.alignItems = "center";
  box.style.justifyContent = "center";
  box.style.width = "min(960px, 94vw)";

  const img = el("img") as HTMLImageElement;
  img.src = loadingScreenUrl;
  img.style.width = "100%";
  img.style.maxHeight = "55vh";
  img.style.objectFit = "contain";
  img.style.display = "block";

  const overlay = el("div", "loading-overlay-content");
  overlay.style.display = "flex";
  overlay.style.flexDirection = "column";
  overlay.style.alignItems = "center";
  overlay.style.width = "100%";
  overlay.style.marginTop = "-6.5rem";

  const lottieContainer = el("div", "lottie-loader");
  lottieContainer.style.width = "125px";
  lottieContainer.style.height = "125px";
  lottieContainer.style.marginBottom = "0.1rem";

  let lottieAnim: any = null;
  const loadLottie = () => {
    const lottie = (window as any).lottie;
    if (lottie) {
      try {
        lottieAnim = lottie.loadAnimation({
          container: lottieContainer,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: blueLoadingData,
        });
      } catch (e) {
        console.warn("Lottie animation error", e);
      }
    }
  };
  loadLottie();

  const status = el("p", "lede joining-status", JOIN_STAGE.find.copy[0]!);
  status.style.margin = "0.1rem 0 0.5rem";
  status.style.color = "#2a1a12";
  status.style.fontSize = "1.3rem";
  status.style.fontWeight = "800";
  status.style.textAlign = "center";

  const track = el("div", "joining-track");
  track.style.width = "100%";
  track.style.maxWidth = "480px";
  track.style.height = "1.35rem";
  track.style.borderRadius = "999px";
  track.style.background = "#e4d6c7";
  track.style.boxShadow = "inset 0 2px 4px rgba(0,0,0,0.18)";

  const fill = el("div", "joining-fill");
  fill.style.height = "100%";
  fill.style.borderRadius = "999px";
  fill.style.background = "linear-gradient(90deg, #c45c28, #e07a3d)";
  track.append(fill);

  overlay.append(lottieContainer, status, track);
  box.append(img, overlay);
  wrap.append(box);
  root.append(wrap);

  let stage: JoinStage = "find";
  let floor = 0;
  let shown = 0;
  let stageAt = performance.now();
  let copyI = 1;
  let alive = true;
  let raf = 0;
  const copyTimer = window.setInterval(() => {
    if (!alive) return;
    const lines = JOIN_STAGE[stage].copy;
    status.textContent = lines[copyI % lines.length]!;
    copyI += 1;
  }, 3200);

  const tick = (now: number) => {
    if (!alive) return;
    const spec = JOIN_STAGE[stage];
    const t = (now - stageAt) / 1000;
    const creep = floor + (spec.cap - floor) * (1 - Math.exp(-t / spec.tau));
    shown = stage === "ready" ? 1 : Math.max(shown, Math.min(spec.cap - 0.004, creep));
    fill.style.width = `${Math.round(shown * 1000) / 10}%`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    setStage(next: JoinStage) {
      if (!alive) return;
      floor = shown;
      stage = next;
      stageAt = performance.now();
      copyI = 1;
      status.textContent = JOIN_STAGE[next].copy[0]!;
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearInterval(copyTimer);
      lottieAnim?.destroy?.();
    },
  };
}

export function renderOnboarding(root: HTMLElement, onComplete: () => void) {
  disposeLandingPreviews();

  const wrap = el("div", "onboarding-wrap");
  wrap.style.position = "absolute";
  wrap.style.inset = "0";
  wrap.style.zIndex = "999";
  wrap.style.backdropFilter = "blur(6px)";
  (wrap.style as any).webkitBackdropFilter = "blur(6px)";
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.background = "rgba(255, 248, 240, 0.55)";

  let step = 0;

  const renderStep = () => {
    wrap.innerHTML = "";

    // Step 0: Game menu overlay
    if (step === 0) {
      const img = el("img") as HTMLImageElement;
      img.src = gameMenuUrl;
      img.style.maxWidth = "100%";
      img.style.maxHeight = "100%";
      img.style.objectFit = "contain";
      img.style.cursor = "pointer";
      img.addEventListener("click", () => {
        try {
          if (sessionStorage.getItem("klase_consent_accepted") === "true") {
            wrap.remove();
            onComplete();
            return;
          }
        } catch { /* ignore */ }
        step++;
        renderStep();
      });
      wrap.append(img);
      return;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    const createHeader = (titleImgUrl: string, titleAlt: string, tagText: string, subtitleText = "") => {
      const head = el("div", "neo-card-head");
      const tag = el("div", "neo-card-tag", tagText);
      const titleImg = el("img", "neo-card-title-img") as HTMLImageElement;
      titleImg.src = titleImgUrl;
      titleImg.alt = titleAlt;
      head.append(tag, titleImg);
      if (subtitleText) head.append(el("p", "neo-card-subtitle", subtitleText));
      return head;
    };

    /** showBack = false on step 1 (first content step) */
    const createFooter = (
      showBack: boolean,
      nextLabel: string,
      onNext: () => void,
      nextDisabled = false,
    ) => {
      const foot = el("div", "neo-card-foot");
      if (showBack) {
        const backBtn = el("button", "neo-btn neo-btn-back", "← Back");
        backBtn.type = "button";
        backBtn.addEventListener("click", () => { step--; renderStep(); });
        foot.append(backBtn);
      }
      const nextBtn = el("button", "neo-btn", nextLabel) as HTMLButtonElement;
      nextBtn.type = "button";
      nextBtn.disabled = nextDisabled;
      nextBtn.addEventListener("click", onNext);
      foot.append(nextBtn);
      return { foot, nextBtn };
    };

    // ── Step 1: How Klase Works ───────────────────────────────────────────────
    if (step === 1) {
      const card = el("div", "neo-card");
      const head = createHeader(howKlaseWorksTextUrl, "How Klase Works", "Step 1 of 5");
      const body = el("div", "neo-card-body");
      const items = [
        "Move around freely using WASD or arrow keys, walk right up to classmates to chat.",
        "Voice chat is proximity-based, you'll only hear people near you.",
        "Each classroom holds up to 12 people. If a room is full, you'll automatically join the next one.",
        "Play as a guest, or sign in to keep the same identity across sessions.",
        "Sit at desks, hang out, or just walk around, the room is yours to explore.",
        "Mute anyone from the player list anytime, it only affects what you see and hear.",
      ];
      items.forEach((text, i) => {
        const row = el("div", "neo-list-item");
        row.append(el("div", "neo-badge", String(i + 1)), el("div", "", text));
        body.append(row);
      });
      const { foot } = createFooter(false, "Next →", () => { step++; renderStep(); });
      card.append(head, body, foot);
      wrap.append(card);
      return;
    }

    // ── Step 2: Community Guidelines ─────────────────────────────────────────
    if (step === 2) {
      const card = el("div", "neo-card");
      const head = createHeader(communityGuidelinesTextUrl, "Community Guidelines", "Step 2 of 5");
      const body = el("div", "neo-card-body");
      const items = [
        "Be respectful, harassment, hate speech, or bullying will get you banned.",
        "No inappropriate content in chat, voice, or your character name, this includes slurs, sexual content, and spam.",
        "Don't impersonate admins, teachers, or other students.",
        "Voice chat is not recorded, but admins can mute you if reported.",
        "This is a school-context space, keep it appropriate for everyone.",
        "Repeated violations lead to permanent IP bans, moderators' decisions are final.",
      ];
      items.forEach((text) => {
        const row = el("div", "neo-list-item");
        row.append(el("div", "neo-badge neo-badge-warn", "!"), el("div", "", text));
        body.append(row);
      });
      const { foot } = createFooter(true, "Next →", () => { step++; renderStep(); });
      card.append(head, body, foot);
      wrap.append(card);
      return;
    }

    // ── Step 3: Terms & Conditions ────────────────────────────────────────────
    if (step === 3) {
      const card = el("div", "neo-card");
      const head = createHeader(infoAndRulesTextUrl, "Terms & Conditions", "Step 3 of 5", "Terms & Conditions");
      const body = el("div", "neo-card-body");
      const terms = [
        { title: "1. Acceptance of Terms", text: "By accessing or using Klase, you agree to comply with and be bound by these Terms & Conditions and our Community Guidelines." },
        { title: "2. Beta & Academic Disclaimer", text: "Klase is a student academic project developed by Harry Lagto (BSIT student at National University Manila) currently in active beta testing. Service availability, features, and user data may change or reset at any time." },
        { title: "3. Acceptable Use & Conduct", text: "Users must refrain from harassment, hate speech, spamming, impersonation, or exploiting system vulnerabilities. Violation of these rules may lead to temporary muting or permanent IP bans." },
        { title: "4. User Accounts & Session Identity", text: "Guest sessions do not collect personal identifiers. Registered account users are responsible for keeping their login credentials secure." },
        { title: "5. Moderation Rights", text: "Klase administrators reserve the right to moderate real-time voice and text channels, mute, kick, or permanently block any user violating guidelines." },
      ];
      terms.forEach((item) => {
        const block = el("div", "neo-policy-block");
        block.append(el("h4", "neo-policy-title", item.title), el("p", "neo-policy-text", item.text));
        body.append(block);
      });
      const { foot } = createFooter(true, "Next →", () => { step++; renderStep(); });
      card.append(head, body, foot);
      wrap.append(card);
      return;
    }

    // ── Step 4: Privacy Policy ────────────────────────────────────────────────
    if (step === 4) {
      const card = el("div", "neo-card");
      const head = createHeader(infoAndRulesTextUrl, "Privacy Policy", "Step 4 of 5", "Privacy Policy");
      const body = el("div", "neo-card-body");
      const sections: Array<{ title: string; text?: string; list?: string[] }> = [
        { title: "1. Overview", text: "This Privacy Policy explains what information Klase collects, how it is used, and your choices regarding that information. Klase is a student academic project developed by Harry Lagto, BSIT student at National University Manila, currently in beta." },
        { title: "2. Information We Collect", list: [
            "Guest Users: No persistent personal data is collected. Guest sessions (display name, character appearance) exist only for the duration of your session and are not saved after you disconnect.",
            "Registered Users (if signed in): Basic account information such as email (used for authentication) and display name.",
            "Character customization choices (e.g., appearance selections), if saved to your profile.",
            "Role/status information (e.g., whether you are an admin, or have been muted/banned), used solely for moderation purposes.",
          ] },
        { title: "3. What We Do Not Collect", list: [
            "Voice chat is not recorded or stored.",
            "Text chat messages are not permanently logged or stored beyond what is necessary for real-time delivery and short-term moderation.",
            "We do not collect payment information, government IDs, or other sensitive personal identifiers.",
          ] },
        { title: "4. How Information Is Used", list: [
            "Maintain your identity and customization across sessions (registered users)",
            "Enforce moderation actions (mute, kick, ban) where applicable",
            "Improve and debug the application during beta testing",
          ] },
        { title: "5. Data Sharing", text: "Klase does not sell, rent, or share your information with third parties. Data may be stored using third-party infrastructure providers solely to operate the application." },
        { title: "6. Data Retention", text: "As Klase is in active beta, data handling practices may evolve. Account data may be deleted periodically during development, testing, or redeployment without prior notice." },
        { title: "7. Your Choices", text: "You may use Klase as a guest to avoid providing any account information. If you have a registered account, you may request account/data deletion by contacting harrylagto@gmail.com." },
        { title: "8. Children's Privacy", text: "Klase is intended for users 18 years of age or older and is not directed toward children. We do not knowingly collect information from users under 18." },
        { title: "9. Changes to This Policy", text: "This Privacy Policy may be updated as the project develops. Continued use of Klase after changes constitutes acceptance of the revised Policy." },
        { title: "10. Contact", text: "For privacy-related questions or data deletion requests, contact: harrylagto@gmail.com" },
      ];
      sections.forEach((sec) => {
        const block = el("div", "neo-policy-block");
        block.append(el("h4", "neo-policy-title", sec.title));
        if (sec.text) block.append(el("p", "neo-policy-text", sec.text));
        if (sec.list) {
          const ul = el("ul", "neo-policy-sublist");
          sec.list.forEach((itm) => ul.append(el("li", "", itm)));
          block.append(ul);
        }
        body.append(block);
      });
      const { foot } = createFooter(true, "Next →", () => { step++; renderStep(); });
      card.append(head, body, foot);
      wrap.append(card);
      return;
    }

    // ── Step 5: Consent & Agreement ───────────────────────────────────────────
    if (step === 5) {
      const card = el("div", "neo-card");
      const head = createHeader(infoAndRulesTextUrl, "Consent & Agreement", "Step 5 of 5", "Final Consent");
      const body = el("div", "neo-card-body");

      const intro = el("div", "neo-policy-block");
      intro.append(
        el("h4", "neo-policy-title", "Please confirm before proceeding"),
        el("p", "neo-policy-text", "You must be 18 years or older and agree to the Terms & Conditions and Privacy Policy to enter Klase."),
      );
      body.append(intro);

      const consentBox = el("div", "neo-consent-box");

      const lblAge = el("label", "neo-checkbox-label");
      const chkAge = el("input", "neo-checkbox") as HTMLInputElement;
      chkAge.type = "checkbox";
      lblAge.append(chkAge, document.createTextNode(" I am 18 years of age or older."));

      const lblAgree = el("label", "neo-checkbox-label");
      const chkAgree = el("input", "neo-checkbox") as HTMLInputElement;
      chkAgree.type = "checkbox";
      lblAgree.append(chkAgree, document.createTextNode(" I have read and agree to the Terms & Conditions and Privacy Policy."));

      consentBox.append(lblAge, lblAgree);
      body.append(consentBox);

      const { foot, nextBtn } = createFooter(true, "▶  Play", () => {
        // Persist consent in sessionStorage so refreshes within the same tab skip full onboarding sequence
        try { sessionStorage.setItem("klase_consent_accepted", "true"); } catch { /* ignore */ }
        wrap.remove();
        onComplete();
      }, true /* starts disabled */);

      const update = () => { nextBtn.disabled = !(chkAge.checked && chkAgree.checked); };
      chkAge.addEventListener("change", update);
      chkAgree.addEventListener("change", update);

      card.append(head, body, foot);
      wrap.append(card);
      return;
    }
  };

  renderStep();
  root.append(wrap);

  return {
    dispose() { wrap.remove(); },
  };
}


let chooserDispose: (() => void) | null = null;

export function disposeLandingPreviews() {
  chooserDispose?.();
  chooserDispose = null;
}

function storedLook(): Look {
  try {
    return normalizeLook(JSON.parse(localStorage.getItem("klase-look") ?? "null"));
  } catch {
    return normalizeLook(null);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

const MIC_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`;
const MIC_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 4l16 16"/></svg>`;

export function setMicButton(btn: HTMLElement, on: boolean, error = "") {
  btn.classList.toggle("primary", on);
  btn.classList.toggle("mic-on", on);
  btn.classList.toggle("warn", Boolean(error));
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const label = error || (on ? "Microphone on" : "Microphone off");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = on ? MIC_ON : MIC_OFF;
}

const SPEAKER_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 9v6h4l5 5V4L9 9H5zm11.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.24 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 9v6h4l5 5V4L9 9H5zm11.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.24 2.5-4.02z"/><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 4l16 16"/></svg>`;

export function setMuteAllButton(btn: HTMLElement, muted: boolean) {
  btn.classList.toggle("primary", muted);
  btn.classList.toggle("warn", muted);
  btn.setAttribute("aria-pressed", muted ? "true" : "false");
  const label = muted ? "Unmute all" : "Mute all";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = muted ? SPEAKER_OFF : SPEAKER_ON;
}

export function setViewButton(btn: HTMLElement, firstPerson: boolean, compact = false) {
  btn.textContent = firstPerson ? (compact ? "Iso" : "Classroom") : compact ? "1st" : "1st person";
  btn.title = firstPerson ? "Classroom view" : "First person";
  btn.setAttribute("aria-pressed", firstPerson ? "true" : "false");
  btn.classList.toggle("primary", firstPerson);
}

export function setFreeCamButton(btn: HTMLElement, on: boolean, visible: boolean) {
  btn.hidden = !visible;
  btn.textContent = on ? "Exit cam" : "Free cam";
  btn.title = on ? "Exit free camera (C)" : "Free fly camera (C)";
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.classList.toggle("primary", on);
}

export function setZoomHud(
  wrap: HTMLElement,
  panel: HTMLElement,
  btn: HTMLElement,
  visible: boolean,
) {
  wrap.hidden = !visible;
  if (!visible) {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("primary");
  }
}

export function renderLanding(
  root: HTMLElement,
  onJoin: (payload: JoinPayload) => void,
  onAccount: (mode: "in" | "up", email: string, password: string, name: string) => void,
  initialError = "",
  startAt?: "menu" | "play" | "account",
  onBackToMenu?: () => void,
) {
  disposeLandingPreviews();
  root.innerHTML = "";
  const wrap = el("div", "landing");
  root.append(wrap);

  type MenuScreen = "menu" | "play" | "account";
  const startScreen: MenuScreen = startAt ?? (
    /sign|account|email|password/i.test(initialError)
      ? "account"
      : initialError
        ? "play"
        : "menu"
  );

  const lockJoin = (btn: HTMLButtonElement) => {
    if (btn.disabled) return false;
    btn.disabled = true;
    return true;
  };

  const paintPortraits = (host: HTMLElement, portraits: Map<BodyId, HTMLImageElement>) => {
    void preloadAvatars()
      .then(() => {
        if (!host.isConnected) return;
        const stops = BODIES.map((id) => paintBodyPortrait(portraits.get(id)!, id));
        chooserDispose = () => {
          for (const stop of stops) stop();
        };
      })
      .catch((e) => console.warn("Character preview failed", e));
  };

  const show = (screen: MenuScreen) => {
    disposeLandingPreviews();
    wrap.innerHTML = "";
    const shell = el("div", "menu-shell");
    const nav = el("div", "menu-nav");

    if (screen === "menu") {
      if (onBackToMenu) {
        wrap.remove();
        onBackToMenu();
        return;
      }
      show("play");
      return;
    }

    if (screen === "play") {
      shell.append(menuBrand("Pick a body and a name, then jump in."));
      const look = storedLook();
      let body: BodyId = look.body;
      const portraits = new Map<BodyId, HTMLImageElement>();
      const pick = el("div", "char-pick");
      for (const id of BODIES) {
        const btn = el("button", `char-card char-${id}${body === id ? " on" : ""}`) as HTMLButtonElement;
        btn.type = "button";
        const frame = el("div", "char-frame");
        const img = el("img") as HTMLImageElement;
        img.alt = BODY_LABELS[id];
        frame.append(img);
        btn.append(frame, el("span", "", BODY_LABELS[id]));
        btn.addEventListener("click", () => {
          body = id;
          look.body = id;
          localStorage.setItem("klase-look", JSON.stringify(look));
          pick.querySelectorAll(".char-card").forEach((n) => n.classList.remove("on"));
          btn.classList.add("on");
        });
        pick.append(btn);
        portraits.set(id, img);
      }
      nav.append(el("label", "", "Character"), pick);
      nav.append(el("label", "", "Display name"));
      const name = el("input", "clay-input") as HTMLInputElement;
      name.id = "name";
      name.maxLength = 24;
      name.placeholder = "Guest";
      name.value = localStorage.getItem("klase-name") ?? "";
      nav.append(name);
      if (initialError) nav.append(el("div", "error-banner", initialError));
      const go = el("button", "clay-btn primary", "Join as guest") as HTMLButtonElement;
      go.type = "button";
      go.addEventListener("click", () => {
        if (!lockJoin(go)) return;
        nav.querySelectorAll("button").forEach((b) => {
          (b as HTMLButtonElement).disabled = true;
        });
        go.textContent = "Joining…";
        const n = name.value.trim() || "Guest";
        localStorage.setItem("klase-name", n);
        const next = { ...storedLook(), body };
        localStorage.setItem("klase-look", JSON.stringify(next));
        onJoin({ name: n, look: next });
      });
      const back = el("button", "clay-btn", "Back") as HTMLButtonElement;
      back.type = "button";
      back.addEventListener("click", () => {
        if (onBackToMenu) {
          wrap.remove();
          onBackToMenu();
        } else {
          show("play");
        }
      });
      nav.append(go, back);
      shell.append(nav);
      wrap.append(shell);
      paintPortraits(wrap, portraits);
      return;
    }

    shell.append(menuBrand("Sign in to keep your look and name."));
    const name = el("input", "clay-input") as HTMLInputElement;
    name.maxLength = 24;
    name.placeholder = "Display name";
    name.value = localStorage.getItem("klase-name") ?? "";
    const email = el("input", "clay-input") as HTMLInputElement;
    email.type = "email";
    email.autocomplete = "email";
    email.placeholder = "Email";
    const pass = el("input", "clay-input") as HTMLInputElement;
    pass.type = "password";
    pass.autocomplete = "current-password";
    pass.placeholder = "Password";
    nav.append(el("label", "", "Display name"), name, el("label", "", "Email"), email, el("label", "", "Password"), pass);
    if (initialError) nav.append(el("div", "error-banner", initialError));
    const signIn = el("button", "clay-btn primary", "Sign in") as HTMLButtonElement;
    const signUp = el("button", "clay-btn", "Create account") as HTMLButtonElement;
    signIn.addEventListener("click", () => {
      if (!lockJoin(signIn)) return;
      signIn.textContent = "Joining…";
      signUp.disabled = true;
      onAccount("in", email.value.trim(), pass.value, name.value.trim() || "Student");
    });
    signUp.addEventListener("click", () => {
      if (!lockJoin(signUp)) return;
      signUp.textContent = "Joining…";
      signIn.disabled = true;
      onAccount("up", email.value.trim(), pass.value, name.value.trim() || "Student");
    });
    const back = el("button", "clay-btn", "Back") as HTMLButtonElement;
    back.type = "button";
    back.addEventListener("click", () => show("menu"));
    nav.append(signIn, signUp, back);
    shell.append(nav);
    wrap.append(shell);
  };

  show(startScreen);
}

export function renderGameShell(root: HTMLElement) {
  root.innerHTML = "";
  const shell = el("div", isTouchUi() ? "game-root touch-ui" : "game-root");
  const canvas = document.createElement("canvas");
  const top = el("div", "hud-top");
  const roomChip = el("div", "hud-chip", "Connecting…");
  const actions = el("div", "hud-actions");
  const micBtn = el("button", "clay-btn mic-btn");
  micBtn.type = "button";
  setMicButton(micBtn, false);
  const muteAllBtn = el("button", "clay-btn icon-btn");
  muteAllBtn.type = "button";
  setMuteAllButton(muteAllBtn, false);
  const viewBtn = el("button", "clay-btn");
  viewBtn.type = "button";
  setViewButton(viewBtn, false, isTouchUi());
  const freeCamBtn = el("button", "clay-btn", "Free cam");
  freeCamBtn.type = "button";
  freeCamBtn.hidden = true;
  setFreeCamButton(freeCamBtn, false, false);
  const playersBtn = el("button", "clay-btn", "Players");
  const lookBtn = el("button", "clay-btn", "Look");
  const chatBtn = el("button", "clay-btn", "Chat");
  const zoomWrap = el("div", "zoom-hud");
  const zoomBtn = el("button", "clay-btn", "Zoom");
  zoomBtn.type = "button";
  zoomBtn.title = "Classroom zoom";
  zoomBtn.setAttribute("aria-label", "Classroom zoom");
  zoomBtn.setAttribute("aria-expanded", "false");
  const zoomPanel = el("div", "zoom-slider-panel");
  zoomPanel.hidden = true;
  const zoomTrack = el("div", "zoom-track");
  const zoomTick = el("div", "zoom-mid-tick");
  zoomTick.setAttribute("aria-hidden", "true");
  const zoomSlider = document.createElement("input");
  zoomSlider.type = "range";
  zoomSlider.className = "zoom-slider";
  zoomSlider.min = "0";
  zoomSlider.max = "100";
  zoomSlider.step = "1";
  zoomSlider.value = "50";
  zoomSlider.setAttribute("orient", "vertical");
  zoomSlider.setAttribute("aria-label", "Zoom level");
  zoomSlider.title = "Default is the middle tick";
  zoomTrack.append(zoomTick, zoomSlider);
  zoomPanel.append(zoomTrack);
  zoomWrap.append(zoomBtn, zoomPanel);
  actions.append(micBtn, muteAllBtn, chatBtn, playersBtn, lookBtn, viewBtn, freeCamBtn, zoomWrap);
  top.append(roomChip, actions);

  const chat = el("div", "chat-dock game-chat empty collapsed");
  const log = el("div", "chat-log");
  const row = el("div", "chat-row");
  const input = el("input", "chat-input") as HTMLInputElement;
  input.placeholder = "Enter to chat";
  const send = el("button", "chat-send", "Send");
  row.append(input, send);
  chat.append(log, row);

  const layer = el("div", "panel-layer hidden");

  const joyWrap = el("div", "joy-wrap");
  const joyBase = el("div", "joy-base");
  const joyKnob = el("div", "joy-knob");
  joyBase.append(joyKnob);
  const sitBtn = el("button", "joy-sit clay-btn", "Sit") as HTMLButtonElement;
  sitBtn.type = "button";
  sitBtn.hidden = true;
  joyWrap.append(joyBase, sitBtn);

  shell.append(canvas, top, chat, joyWrap, layer);
  root.append(shell);
  return {
    top,
    canvas,
    roomChip,
    micBtn,
    muteAllBtn,
    chatBtn,
    chat,
    playersBtn,
    lookBtn,
    viewBtn,
    freeCamBtn,
    zoomWrap,
    zoomBtn,
    zoomPanel,
    zoomSlider,
    log,
    input,
    send,
    layer,
    joyWrap,
    joyBase,
    joyKnob,
    sitBtn,
  };
}

export function setGameHudVisible(ui: ReturnType<typeof renderGameShell> | null, visible: boolean) {
  if (!ui) return;
  ui.top.style.display = visible ? "" : "none";
  ui.chat.style.display = visible ? "none" : "none"; // chat remains controlled by setChatOpen when visible
  if (visible) {
    ui.chat.style.display = "";
  }
  ui.joyWrap.style.display = visible ? "" : "none";
}

export function setChatOpen(
  chat: HTMLElement,
  chatBtn: HTMLElement,
  input: HTMLInputElement,
  open: boolean,
  focus = false,
) {
  chat.classList.toggle("collapsed", !open);
  chatBtn.classList.toggle("primary", open);
  if (open) {
    if (focus) {
      chat.classList.add("composing");
      input.focus();
    }
  } else {
    chat.classList.remove("composing");
    input.blur();
  }
}

export function syncChatVisibility(chat: HTMLElement, log: HTMLElement) {
  chat.classList.toggle("empty", log.childElementCount === 0);
}

export function addChat(
  chat: HTMLElement,
  log: HTMLElement,
  line: ChatLine,
  selfId: string,
  muted: Set<string>,
  opts?: { silent?: boolean },
) {
  if (line.kind === "chat" && muted.has(line.from)) return false;
  const b = el("div", "bubble");
  if (line.from === selfId) b.classList.add("mine");
  if (line.kind === "join-owner" || line.kind === "join" || line.kind === "leave" || line.kind === "leave-owner" || line.kind === "system") b.classList.add("system");
  if (line.kind === "join-admin" || line.kind === "leave-admin") b.classList.add("admin");
  if (line.kind === "chat") {
    // Security: Using `textContent` (via el) instead of `innerHTML` prevents XSS injection from player names
    const who = el("strong", "", line.name);
    // Security: Using `createTextNode` prevents XSS injection from the chat message itself
    b.append(who, document.createTextNode(line.text));
  } else {
    // Security: Using `textContent` assignment protects against XSS in system messages
    b.textContent = line.text;
  }
  log.append(b);
  while (log.childElementCount > CHAT_LOG_MAX) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
  syncChatVisibility(chat, log);
  return !opts?.silent && line.kind === "chat";
}

export function showCustomize(
  layer: HTMLElement,
  look: Look,
  onChange: (next: Look) => void,
  onClose: () => void,
) {
  layer.classList.remove("hidden");
  layer.innerHTML = "";
  const panel = el("div", "clay panel");
  const head = el("div", "panel-head");
  head.append(el("h2", "", "Avatar"), el("button", "clay-btn", "Done"));
  head.querySelector("button")!.addEventListener("click", () => {
    layer.classList.add("hidden");
    onClose();
  });
  panel.append(head, el("p", "lede", "Primitive wearables on a blank body. The 3D preview stays in the classroom."));
  const draft = { ...look };
  (Object.keys(WEARABLES) as WearableSlot[]).forEach((slot) => {
    panel.append(el("label", "", slot));
    const grid = el("div", "wear-grid");
    for (const id of WEARABLES[slot]) {
      const tile = el("button", `clay-btn wear-tile${draft[slot] === id ? " on" : ""}`, WEARABLE_LABELS[id] ?? id);
      tile.addEventListener("click", () => {
        draft[slot] = id;
        onChange({ ...draft });
        showCustomize(layer, draft, onChange, onClose);
      });
      grid.append(tile);
    }
    panel.append(grid);
  });
  layer.append(panel);
}

export function showPlayers(
  layer: HTMLElement,
  players: RemotePlayer[],
  selfId: string,
  role: string,
  muted: Set<string>,
  onMuteLocal: (id: string, mute: boolean) => void,
  onModerate: (action: string, targetId: string) => void,
  onClose: () => void,
  muteAll = false,
  onMuteAll: (on: boolean) => void = () => {},
) {
  layer.classList.remove("hidden");
  layer.innerHTML = "";
  const panel = el("div", "clay panel");
  const head = el("div", "panel-head");
  head.append(el("h2", "", "Players"), el("button", "clay-btn", "Close"));
  head.querySelector("button")!.addEventListener("click", () => {
    layer.classList.add("hidden");
    onClose();
  });
  panel.append(head);
  const allBtn = el("button", muteAll ? "clay-btn warn" : "clay-btn", muteAll ? "Unmute all" : "Mute all");
  allBtn.addEventListener("click", () => {
    onMuteAll(!muteAll);
    showPlayers(layer, players, selfId, role, muted, onMuteLocal, onModerate, onClose, !muteAll, onMuteAll);
  });
  panel.append(allBtn);

  const refresh = () =>
    showPlayers(layer, players, selfId, role, muted, onMuteLocal, onModerate, onClose, muteAll, onMuteAll);

  for (const p of players) {
    const row = el("div", "player-row");
    const left = el("div");
    left.append(document.createTextNode(p.name));
    if (p.role !== "user") {
      left.append(el("span", `badge ${p.role}`, p.role));
    }
    if (p.serverMuted) left.append(el("span", "badge", "muted"));
    const mods = el("div", "mods");
    if (p.sessionId !== selfId) {
      const localMuted = muted.has(p.sessionId);
      const lm = el("button", "clay-btn", localMuted ? "Unmute local" : "Mute local");
      lm.addEventListener("click", () => {
        onMuteLocal(p.sessionId, !localMuted);
        refresh();
      });
      mods.append(lm);
      if (role === "owner" || role === "admin") {
        const add = (label: string, action: string, warn = false) => {
          const b = el("button", warn ? "clay-btn warn" : "clay-btn", label);
          b.addEventListener("click", () => onModerate(action, p.sessionId));
          mods.append(b);
        };
        add(p.serverMuted ? "Unmute" : "Mute", p.serverMuted ? "unmute" : "mute");
        add("Kick", "kick", true);
        add("Ban", "ban", true);
        if (role === "owner" && p.role !== "owner") {
          add(p.role === "admin" ? "Demote" : "Promote", p.role === "admin" ? "demote" : "promote");
        }
      }
    }
    row.append(left, mods);
    panel.append(row);
  }
  layer.append(panel);
}
