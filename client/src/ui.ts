import lottie from "lottie-web";
import { CHAT_LOG_MAX, WEARABLE_LABELS, WEARABLES, normalizeLook, type Look, type WearableSlot } from "@klase/shared";
import type { RemotePlayer, RoomListItem } from "./net";
import { authEnabled } from "./auth";
import { bindPanelHotkeys, renderModerationToolbar, type ModSubmit } from "./moderation";
import { mountLookPicker } from "./lookPicker";
import { isTouchUi } from "./joystick";
import gameMenuUrl from "../../assets/menu-screen/game-menu.png";
import howKlaseWorksTextUrl from "../../assets/menu-screen/how-klase-works-text.png";
import communityGuidelinesTextUrl from "../../assets/menu-screen/klase-community-guidelines-text.png";
import infoAndRulesTextUrl from "../../assets/menu-screen/klase-info-and-rules-text.png";
import loadingScreenUrl from "../../assets/menu-screen/loading-screen.png";
import blueLoadingData from "../../assets/menu-screen/blue-loading.json";

// ---------------------------------------------------------------------------
// Shared SVG icon library — all icons are 24×24 viewBox, currentColor fill
// ---------------------------------------------------------------------------
export const ICONS = {
  mic:        `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`,
  micOff:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 4l16 16"/></svg>`,
  volume:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.24 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
  volumeOff:  `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M5 9v6h4l5 5V4L9 9H5zm11.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.24 2.5-4.02z"/><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 4l16 16"/></svg>`,
  eye:        `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>`,
  eyeOff:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75C21.27 7.11 17 4 12 4c-1.27 0-2.49.2-3.64.57l2.17 2.17C11.04 6.63 11.5 6.5 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>`,
  person:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
  chat:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`,
  zoom:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
  settings:   `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`,
  exit:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>`,
  sit:        `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M7 13.5v-7c0-.83.67-1.5 1.5-1.5S10 5.67 10 6.5V13h5.5c1.1 0 2 .9 2 2s-.9 2-2 2H9c-1.1 0-2-.9-2-2v-1.5zM12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>`,
  stand:      `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M13 6c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zm-1 3.5c-1.33 0-4 .67-4 2V13h8v-1.5c0-1.33-2.67-2-4-2zM9.5 14H8v7h2v-4h4v4h2v-7H9.5z"/></svg>`,
  kick:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17A8.932 8.932 0 0 0 3 12a9 9 0 0 0 18 0c0-2.74-1.23-5.18-3.17-6.83z"/></svg>`,
  ban:        `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z"/></svg>`,
  mute:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`,
  unmute:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.24 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
  message:    `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>`,
  announce:   `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"/></svg>`,
  promote:    `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
  demote:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm4.24 16L12 15.45 7.77 18l1.12-4.81-3.73-3.23 4.92-.42L12 5l1.92 4.53 4.92.42-3.73 3.23L16.23 18z"/></svg>`,
  lock:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>`,
  unlock:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 13c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6-5h-1V6c0-2.76-2.24-5-5-5-2.28 0-4.27 1.54-4.84 3.75l1.94.49C9.51 3.91 10.71 3 12 3c1.65 0 3 1.35 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>`,
  whitelist:  `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
  search:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
  key:        `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>`,
  enter:      `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/></svg>`,
  back:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`,
  signOut:    `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>`,
  players:    `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
  save:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>`,
  close:      `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
  add:        `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`,
  remove:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
  copy:       `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`,
  retry:      `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`,
  noclip:     `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm0 4.99h6v1.01H6V6.99h6zm2 4H10v-2h4v2zm-2 4c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>`,
  admin:      `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 4l5 2.18V11c0 3.5-2.33 6.79-5 7.93-2.67-1.14-5-4.43-5-7.93V7.18L12 5z"/></svg>`,
  controls:   `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>`,
};

/** Create a button with an icon + optional label. */
export function iconBtn<K extends keyof HTMLElementTagNameMap = "button">(
  tag: K,
  cls: string,
  iconKey: keyof typeof ICONS,
  label = "",
  ariaLabel = label,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag) as HTMLElement;
  n.className = cls;
  n.innerHTML = ICONS[iconKey] + (label ? ` <span class="btn-label">${label}</span>` : "");
  if (ariaLabel) n.setAttribute("aria-label", ariaLabel);
  return n as HTMLElementTagNameMap[K];
}

export type ChatLine = {
  from: string;
  name: string;
  text: string;
  kind: string;
  role?: string;
};

export type JoinPayload = { name: string; look: Look; accessToken?: string };
export type JoinStage = "find" | "wake" | "join" | "load" | "ready";

const JOIN_STAGE: Record<JoinStage, { cap: number; tau: number; copy: string[] }> = {
  find: {
    cap: 0.4,
    tau: 14,
    copy: [
      "Connecting you to a classroom…",
      "Finding you a room…",
    ],
  },
  wake: {
    cap: 0.35,
    tau: 22,
    copy: ["Waking up the classroom server, this can take a minute."],
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

  let lottieAnim: ReturnType<typeof lottie.loadAnimation> | null = null;
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
  root.replaceChildren();

  const wrap = el("div", "onboarding-wrap");

  let step = 0;
  let menuStarted = false;

  const startFromMenu = () => {
    if (menuStarted || step !== 0) return;
    menuStarted = true;
    const startBtn = wrap.querySelector<HTMLButtonElement>(".menu-home-start");
    if (startBtn) startBtn.disabled = true;
    try {
      if (sessionStorage.getItem("klase_consent_accepted") === "true") {
        wrap.remove();
        onComplete();
        return;
      }
    } catch { /* ignore */ }
    wrap.classList.remove("onboarding-wrap--menu");
    step = 1;
    renderStep();
  };

  const renderStep = () => {
    wrap.innerHTML = "";

    // Step 0: Game menu — only the real Start button is interactive
    if (step === 0) {
      menuStarted = false;
      wrap.classList.add("onboarding-wrap--menu");
      const home = el("div", "menu-home");
      const cluster = el("div", "menu-home-cluster");
      const img = el("img", "menu-home-art") as HTMLImageElement;
      img.src = gameMenuUrl;
      img.alt = "Klase";
      img.draggable = false;
      const startBtn = el("button", "neo-btn neo-btn-play menu-home-start", "Start") as HTMLButtonElement;
      startBtn.type = "button";
      startBtn.addEventListener("click", startFromMenu);
      cluster.append(img, startBtn);
      home.append(cluster);
      wrap.append(home);
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
        "Each classroom holds up to 12 people. Pick an open room from the classroom list.",
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

const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;

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
  const label = firstPerson ? (compact ? "Iso" : "Classroom") : compact ? "1st" : "1st person";
  btn.innerHTML = (firstPerson ? ICONS.eye : ICONS.eyeOff) + ` <span class="btn-label">${label}</span>`;
  btn.title = firstPerson ? "Classroom view" : "First person";
  btn.setAttribute("aria-pressed", firstPerson ? "true" : "false");
  btn.classList.toggle("primary", firstPerson);
}

type StaffHudHandlers = {
  roomLabel: string;
  role: string;
  observe: boolean;
  actorName: string;
  onBack: () => void;
  listPlayers: () => RemotePlayer[];
  selfId: string;
  onSubmit: (payload: ModSubmit) => void;
  onNoclip: () => void;
};

/**
 * Compact add-on layer. Does not replace or hide the regular game HUD.
 * Wrapper is pointer-events: none so scene clicks still walk the character.
 */
export function renderStaffBar(root: HTMLElement, h: StaffHudHandlers) {
  const layer = el("div", "owner-layer");
  layer.setAttribute("aria-label", h.observe ? "Observe tools" : `${h.role} tools`);
  const pill = el("div", "owner-pill");
  const tag = el("span", "owner-pill-tag", h.observe ? "Observe" : h.role === "admin" ? "Admin" : "Owner");
  const panel = el("div", "owner-panel clay");
  panel.hidden = true;
  renderModerationToolbar(panel, {
    role: h.role,
    actorName: h.actorName,
    getPlayers: () =>
      h.listPlayers()
        .filter((p) => p.sessionId !== h.selfId)
        .map((p) => ({ id: p.sessionId, name: p.name, role: p.role, serverMuted: p.serverMuted, observer: p.observer })),
    onSubmit: h.onSubmit,
  });

  let open = false;
  const setOpen = (next: boolean) => {
    open = next;
    panel.hidden = !open;
    controlsBtn.classList.toggle("primary", open);
    controlsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    controlsBtn.innerHTML = open
      ? ICONS.close + ' <span class="btn-label">Hide</span>'
      : ICONS.controls + ' <span class="btn-label">Controls</span>';
    if (open) document.exitPointerLock();
  };
  const controlsBtn = el("button", "clay-btn") as HTMLButtonElement;
  controlsBtn.innerHTML = ICONS.controls + ' <span class="btn-label">Controls</span>';
  controlsBtn.type = "button";
  controlsBtn.title = "Moderation (G)";
  controlsBtn.addEventListener("click", () => setOpen(!open));
  pill.append(tag, controlsBtn);
  let clipBtn: HTMLButtonElement | null = null;
  if (!h.observe) {
    clipBtn = el("button", "clay-btn") as HTMLButtonElement;
    clipBtn.innerHTML = ICONS.noclip + ' <span class="btn-label">Noclip</span>';
    clipBtn.type = "button";
    clipBtn.addEventListener("click", () => h.onNoclip());
    pill.append(clipBtn);
  }
  const back = el("button", "clay-btn warn") as HTMLButtonElement;
  back.innerHTML = ICONS.admin + ' <span class="btn-label">Admin</span>';
  back.type = "button";
  back.title = "Back to Admin";
  back.addEventListener("click", () => {
    back.disabled = true;
    h.onBack();
  });
  pill.append(back);
  layer.append(pill, panel);
  root.append(layer);
  const place = () => {
    const hud = document.querySelector(".hud-top") as HTMLElement | null;
    if (!hud || hud.style.display === "none" || getComputedStyle(hud).display === "none") {
      layer.style.top = "";
      return;
    }
    layer.style.top = `${Math.round(hud.getBoundingClientRect().bottom + 8)}px`;
  };
  place();
  window.addEventListener("resize", place);
  const hudEl = document.querySelector(".hud-top");
  const ro = typeof ResizeObserver !== "undefined" && hudEl ? new ResizeObserver(place) : null;
  if (hudEl && ro) ro.observe(hudEl);
  const unbind = bindPanelHotkeys(
    () => open,
    () => setOpen(false),
    () => setOpen(!open),
  );
  return {
    remove: () => {
      unbind();
      window.removeEventListener("resize", place);
      ro?.disconnect();
      layer.remove();
    },
    setNoclip: (on: boolean) => {
      if (!clipBtn) return;
      clipBtn.innerHTML = (on ? ICONS.noclip : ICONS.noclip) + ` <span class="btn-label">${on ? "Noclip on" : "Noclip"}</span>`;
      clipBtn.classList.toggle("primary", on);
    },
  };
}

export function setFreeCamButton(btn: HTMLElement, on: boolean, visible: boolean) {
  btn.hidden = !visible;
  btn.innerHTML = (on ? ICONS.eyeOff : ICONS.eye) + ` <span class="btn-label">${on ? "Exit cam" : "Free cam"}</span>`;
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
  onGoogle?: () => Promise<void>,
  onRetry?: () => void,
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
      const pickerFrame = el("div", "neo-picker-frame");

      // ── Header Bar ────────────────────────────────────────────────────────
      const pickerHead = el("div", "neo-picker-head");
      const headTitleWrap = el("div", "neo-picker-head-title");
      headTitleWrap.append(
        el("div", "neo-card-tag", "CHARACTER SELECTION"),
        el("h2", "neo-picker-title-text", "Choose Your Avatar"),
      );
      const accountsOn = authEnabled();
      const headAccountBtn = el(
        "button",
        accountsOn ? "neo-btn neo-btn-ghost-sm" : "neo-btn neo-btn-ghost-sm neo-btn-disabled-soon",
      ) as HTMLButtonElement;
      headAccountBtn.type = "button";
      if (accountsOn) {
        headAccountBtn.textContent = "Account";
        headAccountBtn.addEventListener("click", () => show("account"));
      } else {
        headAccountBtn.disabled = true;
        headAccountBtn.title = "Sign-in is not configured on this site.";
        headAccountBtn.textContent = "Account";
      }
      pickerHead.append(headTitleWrap, headAccountBtn);

      const picker = mountLookPicker(pickerFrame, {
        look: storedLook(),
        enableWearables: false,
        persistLook: true,
      });
      chooserDispose = () => picker.dispose();

      // Display Name Form
      const nameForm = el("div", "neo-name-form");
      nameForm.append(
        el("label", "neo-input-label", "DISPLAY NAME"),
        el("span", "neo-input-sub", "How you'll appear to classmates in room"),
      );

      const nameInput = el("input", "neo-input") as HTMLInputElement;
      nameInput.id = "name";
      nameInput.maxLength = 24;
      nameInput.placeholder = "Enter display name...";
      nameInput.value = localStorage.getItem("klase-name") ?? "";
      nameForm.append(nameInput);

      if (initialError) {
        const banner = el("div", "error-banner", initialError);
        if (onRetry) {
          const retry = el("button", "clay-btn primary", "Try again") as HTMLButtonElement;
          retry.type = "button";
          retry.style.marginTop = "0.6rem";
          retry.addEventListener("click", () => onRetry());
          banner.append(document.createElement("br"), retry);
        }
        picker.rightPanel.append(banner);
      }

      const actionsWrap = el("div", "neo-picker-actions");

      const playBtn = el("button", "neo-btn neo-btn-play", "▶  Play") as HTMLButtonElement;
      playBtn.type = "button";
      playBtn.addEventListener("click", () => {
        if (!lockJoin(playBtn)) return;
        playBtn.disabled = true;
        playBtn.textContent = "Joining…";
        const n = nameInput.value.trim() || "Guest";
        const look = picker.getLook();
        localStorage.setItem("klase-name", n);
        localStorage.setItem("klase-look", JSON.stringify(look));
        onJoin({ name: n, look });
      });

      const backBtn = el("button", "neo-btn neo-btn-back", "← Menu") as HTMLButtonElement;
      backBtn.type = "button";
      backBtn.addEventListener("click", () => {
        if (onBackToMenu) {
          wrap.remove();
          onBackToMenu();
        } else {
          show("play");
        }
      });

      actionsWrap.append(playBtn, backBtn);
      picker.rightPanel.append(nameForm, actionsWrap);
      wrap.append(pickerFrame);
      return;
    }

    shell.append(menuBrand("Sign in to keep your look and name."));
    if (onGoogle) {
      const google = el("button", "clay-btn primary google-btn") as HTMLButtonElement;
      google.type = "button";
      google.innerHTML = GOOGLE_G;
      google.append(document.createTextNode("Sign in with Google"));
      google.addEventListener("click", () => {
        if (!lockJoin(google)) return;
        google.lastChild!.textContent = "Redirecting…";
        onGoogle().catch((e) => {
          google.disabled = false;
          google.lastChild!.textContent = "Sign in with Google";
          const msg = e instanceof Error ? e.message : "Could not start Google sign-in.";
          nav.querySelector(".error-banner")?.remove();
          nav.append(el("div", "error-banner", msg));
        });
      });
      nav.append(google, el("div", "menu-divider", "or use email"));
    }
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
  const freeCamBtn = el("button", "clay-btn") as HTMLButtonElement;
  freeCamBtn.innerHTML = ICONS.eye + ' <span class="btn-label">Free cam</span>';
  freeCamBtn.setAttribute("aria-label", "Free cam");
  freeCamBtn.type = "button";
  freeCamBtn.hidden = true;
  setFreeCamButton(freeCamBtn, false, false);
  const playersBtn = el("button", "clay-btn") as HTMLButtonElement;
  playersBtn.innerHTML = ICONS.players + ' <span class="btn-label">Players</span>';
  playersBtn.setAttribute("aria-label", "Players");
  const chatBtn = el("button", "clay-btn") as HTMLButtonElement;
  chatBtn.innerHTML = ICONS.chat + ' <span class="btn-label">Chat</span>';
  chatBtn.setAttribute("aria-label", "Chat");
  const zoomWrap = el("div", "zoom-hud");
  const zoomBtn = el("button", "clay-btn") as HTMLButtonElement;
  zoomBtn.innerHTML = ICONS.zoom + ' <span class="btn-label">Zoom</span>';
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
  actions.append(micBtn, muteAllBtn, chatBtn, playersBtn, viewBtn, freeCamBtn, zoomWrap);
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
  const sitBtn = el("button", "joy-sit clay-btn") as HTMLButtonElement;
  sitBtn.innerHTML = ICONS.sit + ' <span class="btn-label">Sit</span>';
  sitBtn.setAttribute("aria-label", "Sit");
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
  if (line.kind === "join-owner" || line.kind === "join" || line.kind === "leave" || line.kind === "leave-owner" || line.kind === "system" || line.kind === "announce" || line.kind === "whisper") b.classList.add("system");
  if (line.kind === "join-admin" || line.kind === "leave-admin") b.classList.add("admin");
  if (line.kind === "announce") b.classList.add("announce");
  if (line.kind === "whisper") b.classList.add("whisper");
  if (line.kind === "chat") {
    // Security: Using `textContent` (via el) instead of `innerHTML` prevents XSS injection from player names
    const who = el("strong");
    who.append(document.createTextNode(line.name));
    if (line.role === "owner" || line.role === "admin") {
      who.append(el("span", `badge ${line.role}`, line.role.toUpperCase()));
    }
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

export function renderRoomSelect(
  root: HTMLElement,
  opts: {
    name: string;
    rooms: RoomListItem[] | null;
    error?: string;
    retryable?: boolean;
    onJoin: (roomKey: string, passcode?: string) => void;
    onChangeCharacter: () => void;
    onBackMenu: () => void;
    onRetry?: () => void;
  },
) {
  disposeLandingPreviews();
  root.innerHTML = "";
  const wrap = el("div", "landing");
  const frame = el("div", "neo-picker-frame room-select");
  const head = el("div", "neo-picker-head");
  const titleWrap = el("div", "neo-picker-head-title");
  titleWrap.append(el("div", "neo-card-tag", "CLASSROOMS"), el("h2", "neo-picker-title-text", "Pick a room"));
  const who = el("p", "room-select-who", `Playing as ${opts.name || "Guest"}`);
  head.append(titleWrap, who);

  const body = el("div", "room-select-list");
  if (opts.error) body.append(el("div", "error-banner", opts.error));
  if (!opts.rooms) {
    if (!opts.error) body.append(el("p", "lede room-select-status", "Checking classrooms…"));
  } else {
    for (const room of opts.rooms) {
      const isLocked = room.locked === true;
      const isDisabled = room.full || isLocked;
      const card = el("button", `clay room-card${room.full ? " is-full" : ""}${isLocked ? " is-locked" : ""}`) as HTMLButtonElement;
      card.type = "button";
      card.disabled = isDisabled;
      const title = el("div", "room-card-title", room.label);
      const count = el("div", "room-card-count", isLocked ? "🔒 Locked" : `${room.regulars} / ${room.cap}`);
      const stateText = isLocked ? "Locked" : room.full ? "Full" : "Available";
      const stateCls = isLocked ? "locked" : room.full ? "full" : "open";
      const state = el("div", `room-card-state ${stateCls}`, stateText);
      card.append(title, count, state);
      card.addEventListener("click", () => {
        if (isDisabled) return;
        opts.onJoin(room.roomKey);
      });
      body.append(card);

      // Passcode entry for locked rooms
      if (isLocked) {
        const pcWrap = el("div", "room-passcode-wrap");
        const pcInput = el("input", "clay-input room-passcode-input") as HTMLInputElement;
        pcInput.placeholder = "Enter passcode…";
        pcInput.maxLength = 32;
        const pcBtn = el("button", "neo-btn room-passcode-btn", "Join with passcode") as HTMLButtonElement;
        pcBtn.type = "button";
        const submitPasscode = () => {
          const code = pcInput.value.trim();
          if (!code) { pcInput.focus(); return; }
          opts.onJoin(room.roomKey, code);
        };
        pcBtn.addEventListener("click", submitPasscode);
        pcInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitPasscode(); });
        pcWrap.append(pcInput, pcBtn);
        body.append(pcWrap);
      }
    }
  }

  const actions = el("div", "room-select-actions");
  const change = el("button", "neo-btn", "Change character");
  change.type = "button";
  change.addEventListener("click", opts.onChangeCharacter);
  const back = el("button", "neo-btn neo-btn-back", "← Menu");
  back.type = "button";
  back.addEventListener("click", opts.onBackMenu);
  actions.append(change, back);
  if (opts.retryable && opts.onRetry) {
    const retry = el("button", "neo-btn neo-btn-play", "Retry");
    retry.type = "button";
    retry.addEventListener("click", opts.onRetry);
    actions.prepend(retry);
  }

  frame.append(head, body, actions);
  wrap.append(frame);
  root.append(wrap);
}

export function renderLeaveConfirm(host: HTMLElement, onLeave: () => void, onStay: () => void) {
  const wrap = el("div", "leave-modal-back");
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-labelledby", "leave-title");
  const card = el("div", "clay leave-modal");
  card.append(el("h2", "", "Leave classroom?"));
  const title = card.firstElementChild as HTMLElement;
  title.id = "leave-title";
  card.append(el("p", "lede", "Are you sure you want to leave?"));
  const actions = el("div", "leave-modal-actions");
  const stay = el("button", "clay-btn", "Stay") as HTMLButtonElement;
  const leave = el("button", "clay-btn primary", "Leave") as HTMLButtonElement;
  stay.type = "button";
  leave.type = "button";
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    wrap.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      onStay();
    }
  };
  stay.addEventListener("click", () => {
    close();
    onStay();
  });
  leave.addEventListener("click", () => {
    close();
    onLeave();
  });
  window.addEventListener("keydown", onKey, true);
  actions.append(stay, leave);
  card.append(actions);
  wrap.append(card);
  host.append(wrap);
  stay.focus();
  return { close };
}
