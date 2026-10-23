export type PairingPayload = {
  host: string;
  port: number;
  code: string;
  expiresAt: string;
  protocol: 'wireless-controller-v1';
};

export type ControllerInput = {
  type: 'input';
  buttons: string[];
  axes: {
    leftX: number; leftY: number; rightX: number; rightY: number;
    leftTrigger: number; rightTrigger: number;
  };
};

export function parsePairingPayload(raw: string): PairingPayload {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new Error('The QR code is not valid JSON. Open the V_Control pairing screen on the PC.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('This QR code is not a valid V_Control pairing code.');
  }
  const value = parsed as Partial<PairingPayload>;
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
  if (!ipv4.test(host) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 ||
      typeof value.code !== 'string' || !/^\d{6}$/.test(value.code) || typeof value.expiresAt !== 'string' ||
      value.protocol !== 'wireless-controller-v1') {
    throw new Error('This QR code is not a valid V_Control pairing code.');
  }
  // Do not reject QR codes using the phone clock: phone and PC clocks can differ.
  // The PC's PairingManager remains authoritative for expiry and one-time use.
  // Validate timestamp shape only. Never compare it with the phone clock: the PC is
  // authoritative for code expiry and one-time use, and the two clocks can drift.
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry)) throw new Error('This QR code has an invalid expiry timestamp. Generate a new one on the PC.');
  return { host, port: Number(value.port), code: value.code, expiresAt: value.expiresAt, protocol: 'wireless-controller-v1' };
}


export type ControlProfile = 'Balanced' | 'FPS' | 'Racing' | 'Flight';

const PROFILE_TUNING: Record<ControlProfile, { sensitivity: number; invertRightY: boolean }> = {
  Balanced: { sensitivity: 1, invertRightY: false },
  FPS: { sensitivity: 1.25, invertRightY: false },
  Racing: { sensitivity: 0.9, invertRightY: false },
  Flight: { sensitivity: 1, invertRightY: true },
};

/** Apply the selected local stick tuning without changing the server's protocol shape. */
export function applyProfileAxes(axes: ControllerInput['axes'], profile: ControlProfile): ControllerInput['axes'] {
  const tuning = PROFILE_TUNING[profile];
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return {
    leftX: clamp(axes.leftX * tuning.sensitivity),
    leftY: clamp(axes.leftY * tuning.sensitivity),
    rightX: clamp(axes.rightX * tuning.sensitivity),
    rightY: clamp(axes.rightY * tuning.sensitivity * (tuning.invertRightY ? -1 : 1)),
    leftTrigger: Math.max(0, Math.min(1, axes.leftTrigger)),
    rightTrigger: Math.max(0, Math.min(1, axes.rightTrigger)),
  };
}
