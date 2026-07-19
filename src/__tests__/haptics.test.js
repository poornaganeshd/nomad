// Guards the delegated haptics system (haptics.js). The bug class this
// prevents: haptics wired per-button, so some taps buzzed and others didn't.
// The global click listener must tick for EVERY interactive tap, legacy inline
// calls must not double-buzz the same gesture, and outcome haptics must always
// get through.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let vibrateMock;
let detach = () => {};
let h;

const tick = () => new Promise(r => setTimeout(r, 0)); // let the gesture flag reset

beforeEach(async () => {
  localStorage.clear();
  document.body.innerHTML = "";
  vibrateMock = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { value: vibrateMock, configurable: true, writable: true });
  vi.resetModules();
  h = await import("../haptics.js");
  detach = h.attachGlobalHaptics(document);
});

afterEach(async () => {
  detach();
  await tick(); // drain any pending gesture-flag reset before the next test
  vi.restoreAllMocks();
});

describe("global delegated tick", () => {
  it("buzzes once for a tap on a <button>", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.click();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });

  it("buzzes for a clickable div styled cursor:pointer (card-style targets)", () => {
    const card = document.createElement("div");
    card.style.cursor = "pointer";
    document.body.appendChild(card);
    card.click();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });

  it("buzzes when the tap lands on a child of the interactive element", () => {
    const btn = document.createElement("button");
    const inner = document.createElement("span");
    btn.appendChild(inner);
    document.body.appendChild(btn);
    inner.click();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent for non-interactive targets", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.click();
    expect(vibrateMock).not.toHaveBeenCalled();
  });

  it("stays silent when focusing a text input", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.click();
    expect(vibrateMock).not.toHaveBeenCalled();
  });

  it("is idempotent — attaching twice doesn't double-tick", () => {
    h.attachGlobalHaptics(document); // second attach must no-op
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.click();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });
});

describe("same-gesture dedupe", () => {
  it("swallows a legacy inline hapticSelection fired by the same tap", () => {
    const btn = document.createElement("button");
    btn.addEventListener("click", () => h.hapticSelection()); // old-style wiring
    document.body.appendChild(btn);
    btn.click();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });

  it("two separate rapid taps both buzz (no fixed time window on the tap tier)", async () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.click();
    await tick();
    btn.click();
    expect(vibrateMock).toHaveBeenCalledTimes(2);
  });

  it("an explicit tap-tier call outside any click still buzzes", () => {
    h.hapticLight(); // e.g. gesture/keyboard path with no click event
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });
});

describe("outcome tier", () => {
  it("success fires even immediately after a tap tick", () => {
    const btn = document.createElement("button");
    btn.addEventListener("click", () => h.hapticSuccess()); // save → success toast
    document.body.appendChild(btn);
    btn.click();
    expect(vibrateMock).toHaveBeenCalledTimes(2); // tick + success pattern
    expect(vibrateMock).toHaveBeenLastCalledWith([35, 45, 55]);
  });

  it("coalesces a burst of identical toasts into one pulse", () => {
    h.hapticError();
    h.hapticError(); // same-millisecond cascade
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });

  it("hapticForToast maps success/error and ignores info", () => {
    h.hapticForToast("info");
    expect(vibrateMock).not.toHaveBeenCalled();
    h.hapticForToast("error");
    expect(vibrateMock).toHaveBeenCalledWith([65, 70, 65]);
  });
});

describe("settings toggle", () => {
  it("disabling haptics silences both tiers and persists", () => {
    h.setHapticsEnabled(false);
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.click();
    h.hapticSuccess();
    expect(vibrateMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("nomad-haptics")).toBe("off");
    expect(h.hapticsEnabled()).toBe(false);
  });

  it("re-enabling restores the tick", () => {
    h.setHapticsEnabled(false);
    h.setHapticsEnabled(true);
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.click();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });
});
