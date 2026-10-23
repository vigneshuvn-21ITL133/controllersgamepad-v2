import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProfileAxes, parsePairingPayload } from '../src/controllerProtocol.ts';

const payload = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  host: '192.168.1.20', port: 8557, code: '042681',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  protocol: 'wireless-controller-v1', ...overrides,
});

test('accepts a valid unexpired IPv4 pairing payload', () => {
  const parsed = parsePairingPayload(payload());
  assert.equal(parsed.host, '192.168.1.20');
  assert.equal(parsed.port, 8557);
  assert.equal(parsed.code, '042681');
});

test('rejects invalid JSON and non-object QR contents', () => {
  assert.throws(() => parsePairingPayload('{broken'), /not valid JSON/);
  assert.throws(() => parsePairingPayload('null'), /valid V_Control pairing code/);
  assert.throws(() => parsePairingPayload('[]'), /valid V_Control pairing code/);
});

test('rejects a non-V_Control protocol or malformed code', () => {
  assert.throws(() => parsePairingPayload(payload({ protocol: 'other-v1' })), /valid V_Control pairing code/);
  assert.throws(() => parsePairingPayload(payload({ code: '126' })), /valid V_Control pairing code/);
});

test('rejects invalid IPv4 addresses and ports', () => {
  assert.throws(() => parsePairingPayload(payload({ host: '999.1.1.1' })), /valid V_Control pairing code/);
  assert.throws(() => parsePairingPayload(payload({ port: 70000 })), /valid V_Control pairing code/);
});

test('does not reject a code based on phone clock, but rejects malformed timestamps', () => {
  const parsed = parsePairingPayload(payload({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
  assert.equal(parsed.code, '042681'); // The PC validates actual expiry when pairing.
  assert.throws(() => parsePairingPayload(payload({ expiresAt: 'not-a-date' })), /invalid expiry timestamp/);
});


test('applies profile stick sensitivity, inversion, and clamps without changing triggers', () => {
  const axes = { leftX: 0.8, leftY: -0.4, rightX: 0.5, rightY: 0.75, leftTrigger: 0.7, rightTrigger: 1.2 };
  const fps = applyProfileAxes(axes, 'FPS');
  assert.equal(fps.leftX, 1);
  assert.equal(fps.leftY, -0.5);
  assert.equal(fps.rightX, 0.625);
  assert.equal(fps.rightY, 0.9375);
  assert.equal(fps.leftTrigger, 0.7);
  assert.equal(fps.rightTrigger, 1);
  const flight = applyProfileAxes(axes, 'Flight');
  assert.equal(flight.rightY, -0.75);
  const racing = applyProfileAxes(axes, 'Racing');
  assert.equal(racing.leftX, 0.7200000000000001);
});


test('keeps the Expo SDK target on the SDK 57 release line', async () => {
  const fs = await import('node:fs');
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.dependencies.expo, '57.0.31');
});
