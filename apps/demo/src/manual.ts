/**
 * QR pairing demo — public API only. No server anywhere.
 */
import { openSpace, manualPair, existing, generateDeviceId } from "tangentfeed";
import { mountTaskApp, el, flashError } from "./ui.js";
import QRCode from "qrcode";

const deviceId = generateDeviceId();
const transport = manualPair({
  deviceId,
  onState: (s) => {
    el("pair-state").textContent = s;
    el("pair-state").style.color = s === "connected" ? "#2a2" : s === "failed" ? "#c33" : "#c93";
    if (s === "connected") void enterApp();
    if (s === "failed") flashError("connection failed — reload both pages and pair again");
  },
});
el("device").textContent = deviceId;

async function showQr(canvasId: string, text: string) {
  await QRCode.toCanvas(el<HTMLCanvasElement>(canvasId), text, {
    errorCorrectionLevel: "L",
    margin: 1,
    scale: 3,
  });
}

async function scanInto(input: HTMLTextAreaElement): Promise<void> {
  const Detector = (globalThis as Record<string, unknown>)["BarcodeDetector"] as
    | (new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> })
    | undefined;
  if (!Detector) {
    flashError("camera scanning unsupported here — copy & paste the code instead");
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const video = el<HTMLVideoElement>("scanner");
  video.srcObject = stream;
  video.style.display = "";
  await video.play();
  const detector = new Detector({ formats: ["qr_code"] });
  const stop = () => {
    stream.getTracks().forEach((t) => t.stop());
    video.style.display = "none";
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const codes = await detector.detect(video);
      if (codes.length > 0) {
        input.value = codes[0]!.rawValue;
        stop();
        input.dispatchEvent(new Event("scanned"));
        return;
      }
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  flashError("no QR code found — try pasting instead");
}

el<HTMLButtonElement>("btn-create").onclick = async () => {
  el("choose-panel").style.display = "none";
  el("create-panel").style.display = "";
  try {
    const offer = await transport.createOffer();
    await showQr("offer-qr", offer);
    el<HTMLTextAreaElement>("offer-blob").value = offer;
  } catch (err) { flashError(String(err)); }
};
el<HTMLButtonElement>("btn-copy-offer").onclick = () =>
  void navigator.clipboard.writeText(el<HTMLTextAreaElement>("offer-blob").value);

const answerInput = el<HTMLTextAreaElement>("answer-blob");
const acceptAnswer = async () => {
  try { await transport.acceptAnswer(answerInput.value); }
  catch (err) { flashError(String(err)); }
};
el<HTMLButtonElement>("btn-accept-answer").onclick = acceptAnswer;
answerInput.addEventListener("scanned", acceptAnswer);
el<HTMLButtonElement>("btn-scan-answer").onclick = () => void scanInto(answerInput);

el<HTMLButtonElement>("btn-join").onclick = () => {
  el("choose-panel").style.display = "none";
  el("join-panel").style.display = "";
};
const offerInput = el<HTMLTextAreaElement>("offer-input");
const acceptOffer = async () => {
  try {
    const answer = await transport.acceptOffer(offerInput.value);
    el("answer-out").style.display = "";
    await showQr("answer-qr", answer);
    el<HTMLTextAreaElement>("answer-blob-out").value = answer;
  } catch (err) { flashError(String(err)); }
};
el<HTMLButtonElement>("btn-accept-offer").onclick = acceptOffer;
offerInput.addEventListener("scanned", acceptOffer);
el<HTMLButtonElement>("btn-scan-offer").onclick = () => void scanInto(offerInput);
el<HTMLButtonElement>("btn-copy-answer").onclick = () =>
  void navigator.clipboard.writeText(el<HTMLTextAreaElement>("answer-blob-out").value);

let entered = false;
async function enterApp() {
  if (entered) return;
  entered = true;
  el("create-panel").style.display = "none";
  el("join-panel").style.display = "none";
  el("app-panel").style.display = "";

  const space = transport.space ?? "manual";
  el("space-label").textContent = space;
  const db = await openSpace({ space, deviceId, transports: [existing(transport)] });
  mountTaskApp(db);
}
