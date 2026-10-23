import React, { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { applyProfileAxes, parsePairingPayload } from './src/controllerProtocol';
import type { ControlProfile, ControllerInput, PairingPayload } from './src/controllerProtocol';

type ConnectionState = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error';
type ControlMode = 'gamepad' | 'keyboard' | 'mouse' | 'more';
type FaceLayout = 'xbox' | 'playstation';
type Axes = { leftX: number; leftY: number; rightX: number; rightY: number; leftTrigger: number; rightTrigger: number };
type DesktopCommand = {
  type: 'desktop'; action: 'key' | 'type' | 'move' | 'mouseButton' | 'scroll';
  key?: string; down?: boolean; text?: string; dx?: number; dy?: number; button?: string; delta?: number;
};
const EMPTY_AXES: Axes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, leftTrigger: 0, rightTrigger: 0 };
const KEY_ROWS = [['F1','F2','F3','F4','F5','F6'], ['F7','F8','F9','F10','F11','F12'], ['1','2','3','4','5','6','7','8','9','0'], ['Q','W','E','R','T','Y','U','I','O','P'], ['A','S','D','F','G','H','J','K','L'], ['SHIFT','Z','X','C','V','B','N','M','BACKSPACE'], ['CTRL','ALT','WIN','LEFT','DOWN','UP','RIGHT']];

export default function App() {
  return <SafeAreaProvider style={{ flex: 1 }}><ControllerApp /></SafeAreaProvider>;
}

function ControllerApp() {
  const [permission, requestPermission] = useCameraPermissions();
  const [state, setState] = useState<ConnectionState>('idle');
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [manualAddress, setManualAddress] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [pressed, setPressed] = useState<string[]>([]);
  const [axes, setAxes] = useState<Axes>(EMPTY_AXES);
  const [mode, setMode] = useState<ControlMode>('gamepad');
  const [faceLayout, setFaceLayout] = useState<FaceLayout>('xbox');
  const [profileName, setProfileName] = useState<ControlProfile>('Balanced');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [message, setMessage] = useState('Scan the pairing QR shown in the Windows companion, or enter the PC details below.');
  const [latency, setLatency] = useState<number | null>(null);
  const [typedText, setTypedText] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const heldDesktopKeys = useRef(new Set<string>());
  const heldDesktopMouseButtons = useRef(new Set<string>());
  const scanned = useRef(false);
  const inputRef = useRef({ pressed, axes });
  const mousePosition = useRef<{ x: number; y: number } | null>(null);
  const profileRef = useRef<ControlProfile>(profileName);
  inputRef.current = { pressed, axes };
  profileRef.current = profileName;

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem('vcontrol.controlProfile').then((saved) => {
      if (mounted && saved && ['Balanced', 'FPS', 'Racing', 'Flight'].includes(saved)) setProfileName(saved as ControlProfile);
    }).catch(() => { /* Default profile remains usable if local storage is unavailable. */ }).finally(() => { if (mounted) setProfileLoaded(true); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (profileLoaded) AsyncStorage.setItem('vcontrol.controlProfile', profileName).catch(() => { /* Storage is optional to live input. */ });
  }, [profileLoaded, profileName]);

  useEffect(() => () => {
    const activeSocket = socket.current;
    socket.current = null;
    activeSocket?.close();
  }, []);

  // Use refs so the fixed-rate heartbeat doesn't restart on every touch/stick update.
  useEffect(() => {
    if (state !== 'connected') return;
    const timer = setInterval(() => {
      const latest = inputRef.current;
      sendInput(latest.pressed, latest.axes);
    }, 33);
    const pingTimer = setInterval(() => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
    }, 2000);
    return () => { clearInterval(timer); clearInterval(pingTimer); };
  }, [state]);

  const sendInput = useCallback((nextButtons = inputRef.current.pressed, nextAxes = inputRef.current.axes) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const packet: ControllerInput = { type: 'input', buttons: nextButtons, axes: applyProfileAxes(nextAxes, profileRef.current) };
    try { ws.send(JSON.stringify(packet)); } catch { /* onclose/onerror updates connection state */ }
  }, []);

  const sendDesktop = useCallback((command: Omit<DesktopCommand, 'type'>) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const packet: DesktopCommand = { type: 'desktop', ...command };
    try { ws.send(JSON.stringify(packet)); } catch { /* socket may have closed */ }
  }, []);

  // Track held key/button state so phone app backgrounding and tab changes can always release it.
  const sendTrackedDesktopInput = useCallback((command: Omit<DesktopCommand, 'type'>) => {
    if (command.action === 'key' && command.key) {
      if (command.down) heldDesktopKeys.current.add(command.key.toUpperCase());
      else heldDesktopKeys.current.delete(command.key.toUpperCase());
    } else if (command.action === 'mouseButton' && command.button) {
      const button = command.button.toUpperCase();
      if (command.down) heldDesktopMouseButtons.current.add(button);
      else heldDesktopMouseButtons.current.delete(button);
    }
    sendDesktop(command);
  }, [sendDesktop]);

  const releaseHeldDesktopInput = useCallback(() => {
    for (const key of heldDesktopKeys.current) sendDesktop({ action: 'key', key, down: false });
    for (const button of heldDesktopMouseButtons.current) sendDesktop({ action: 'mouseButton', button, down: false });
    heldDesktopKeys.current.clear();
    heldDesktopMouseButtons.current.clear();
  }, [sendDesktop]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active') {
        releaseHeldDesktopInput();
        // Send a neutral gamepad state before Android/iOS suspends timers.
        inputRef.current = { pressed: [], axes: EMPTY_AXES };
        setPressed([]);
        setAxes(EMPTY_AXES);
        sendInput([], EMPTY_AXES);
      }
    });
    return () => subscription.remove();
  }, [releaseHeldDesktopInput, sendInput]);

  const changeMode = useCallback((nextMode: ControlMode) => {
    Keyboard.dismiss();
    releaseHeldDesktopInput();
    // A mode change is a release boundary: don't carry a pressed stick/button into another tab.
    inputRef.current = { pressed: [], axes: EMPTY_AXES };
    setPressed([]);
    setAxes(EMPTY_AXES);
    sendInput([], EMPTY_AXES);
    mousePosition.current = null;
    setMode(nextMode);
  }, [releaseHeldDesktopInput, sendInput]);

  const disconnect = useCallback(() => {
    releaseHeldDesktopInput();
    const active = socket.current;
    socket.current = null;
    active?.close();
    setPressed([]);
    setAxes(EMPTY_AXES);
    setLatency(null);
    setState('idle');
    setMessage('Disconnected. Scan a fresh code or enter the PC details again.');
    scanned.current = false;
    mousePosition.current = null;
  }, [releaseHeldDesktopInput]);

  function connect(payload: PairingPayload) {
    releaseHeldDesktopInput();
    // Invalidate the previous socket before closing it; its close event may be delivered late.
    const previous = socket.current;
    socket.current = null;
    previous?.close();
    setPairing(payload);
    setState('connecting');
    setMessage(`Connecting to ${payload.host}:${payload.port}…`);
    setLatency(null);
    let terminalError = false;
    let paired = false;
    const ws = new WebSocket(`ws://${payload.host}:${payload.port}`);
    socket.current = ws;
    const connectTimeout = setTimeout(() => {
      if (socket.current !== ws || ws.readyState === WebSocket.CLOSED) return;
      terminalError = true;
      setState('error');
      setMessage('Connection timed out. Check the PC address, same Wi-Fi, firewall, and that V_Control is running.');
      try { ws.close(); } catch { /* already closing */ }
    }, 10000);

    ws.onopen = () => {
      if (socket.current !== ws) { ws.close(); return; }
      try { ws.send(JSON.stringify({ type: 'pair', code: payload.code })); }
      catch {
        terminalError = true;
        clearTimeout(connectTimeout);
        setState('error');
        setMessage('Could not send the pairing code. Generate a fresh code on the PC.');
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      try {
        const packet = JSON.parse(String(event.data));
        if (packet.type === 'paired') {
          clearTimeout(connectTimeout);
          paired = true;
          setState('connected');
          setMessage(`Pairing accepted with ${payload.host}.`);
        } else if (packet.type === 'pong' && Number.isFinite(packet.clientTime)) {
          setLatency(Math.max(0, Date.now() - Number(packet.clientTime)));
        } else if (packet.type === 'error') {
          terminalError = true;
          clearTimeout(connectTimeout);
          setState('error');
          setMessage(packet.message || 'Pairing failed. Generate a new code on the PC.');
          ws.close();
        }
      } catch {
        terminalError = true;
        clearTimeout(connectTimeout);
        setState('error');
        setMessage('Received an invalid response from the PC.');
        ws.close();
      }
    };
    ws.onerror = () => {
      if (socket.current !== ws) return;
      terminalError = true;
      clearTimeout(connectTimeout);
      setState('error');
      setMessage('Could not reach the PC. Check same Wi-Fi, PC address, Private firewall access, and that the listener is running.');
    };
    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (socket.current !== ws) return;
      socket.current = null;
      heldDesktopKeys.current.clear();
      heldDesktopMouseButtons.current.clear();
      mousePosition.current = null;
      setPressed([]);
      setAxes(EMPTY_AXES);
      setLatency(null);
      setState(terminalError ? 'error' : 'idle');
      if (!terminalError) setMessage(paired ? 'PC connection closed. Pair again with a new code.' : 'Disconnected. Scan a fresh code or enter the PC details again.');
    };
  }

  function handleQr(raw: string) {
    if (scanned.current) return;
    scanned.current = true;
    try { connect(parsePairingPayload(raw)); }
    catch (error) {
      scanned.current = false;
      Alert.alert('Cannot pair', error instanceof Error ? error.message : 'Invalid QR code');
    }
  }

  function manualConnect() {
    try {
      const address = manualAddress.trim();
      const splitAt = address.lastIndexOf(':');
      const host = splitAt > 0 ? address.slice(0, splitAt) : address;
      const port = splitAt > 0 ? Number(address.slice(splitAt + 1)) : 8557;
      const hostIsIpv4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host);
      const normalizedCode = manualCode.trim().replace(/[\s-]/g, '');
      if (!hostIsIpv4 || !Number.isInteger(port) || port < 1 || port > 65535 || !/^\d{6}$/.test(normalizedCode)) {
        throw new Error('Enter the PC IPv4 address (optionally with :8557) and the six-digit pairing code.');
      }
      connect({ host, port, code: normalizedCode, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), protocol: 'wireless-controller-v1' });
      Keyboard.dismiss();
    } catch (error) { Alert.alert('Connection details', error instanceof Error ? error.message : 'Invalid details'); }
  }

  function setButton(button: string, down: boolean) {
    const previous = inputRef.current.pressed;
    const next = down ? Array.from(new Set([...previous, button])) : previous.filter((item) => item !== button);
    inputRef.current = { ...inputRef.current, pressed: next };
    setPressed(next);
    sendInput(next, inputRef.current.axes);
  }

  function setStick(prefix: 'left' | 'right', x: number, y: number) {
    const nextAxes = { ...inputRef.current.axes, [`${prefix}X`]: x, [`${prefix}Y`]: y } as Axes;
    inputRef.current = { ...inputRef.current, axes: nextAxes };
    setAxes(nextAxes);
    sendInput(inputRef.current.pressed, nextAxes);
  }

  function setTrigger(which: 'leftTrigger' | 'rightTrigger', down: boolean) {
    const nextAxes = { ...inputRef.current.axes, [which]: down ? 1 : 0 };
    inputRef.current = { ...inputRef.current, axes: nextAxes };
    setAxes(nextAxes);
    sendInput(inputRef.current.pressed, nextAxes);
  }

  const faceLabels: Record<string, string> = faceLayout === 'xbox'
    ? { Y: 'Y', X: 'X', B: 'B', A: 'A' }
    : { Y: '△', X: '□', B: '○', A: '✕' };

  if (state !== 'connected') {
    return <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.container}>
      <KeyboardAvoidingView style={styles.flexFill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.connectContent} keyboardShouldPersistTaps="handled">
        <BrandMark />
        <View style={styles.heroBlock}>
          <View style={styles.heroIcon}><Text style={styles.heroIconText}>⌘</Text></View>
          <Text style={styles.title}>Your phone, reimagined.</Text>
          <Text style={styles.subtitle}>Connect to your Windows PC and switch between a responsive gamepad and desktop remote.</Text>
        </View>
        <View style={styles.statusCard}>
          <View style={[styles.statusDot, state === 'connecting' ? styles.amberDot : styles.silverDot]} />
          <View style={{ flex: 1 }}><Text style={styles.cardTitle}>{state === 'connecting' ? 'Connecting to PC' : state === 'scanning' ? 'Scanner ready' : state === 'error' ? 'Connection needs attention' : 'Not connected'}</Text><Text style={styles.statusMessage}>{message}</Text></View>
          {state === 'connecting' ? <Text style={styles.monoSmall}>…</Text> : null}
        </View>

        {state === 'scanning' ? <View style={styles.cameraCard}>
          <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => handleQr(data)} />
          <View style={styles.scanFrame} pointerEvents="none"><View style={styles.scanCornerTL} /><View style={styles.scanCornerTR} /><View style={styles.scanCornerBL} /><View style={styles.scanCornerBR} /></View>
          <Pressable style={styles.cancelScan} onPress={() => { setState('idle'); scanned.current = false; }}><Text style={styles.cancelScanText}>Cancel scanner</Text></Pressable>
        </View> : <Pressable style={styles.primaryButton} onPress={async () => {
          if (!permission?.granted) {
            const result = await requestPermission();
            if (!result.granted) { Alert.alert('Camera permission required', 'Allow camera access to scan the pairing QR code, or use manual connection below.'); return; }
          }
          scanned.current = false;
          setState('scanning');
        }}><Text style={styles.primaryButtonText}>▦   Scan pairing QR code</Text></Pressable>}

        <View style={styles.orDivider}><View style={styles.dividerLine} /><Text style={styles.orText}>OR CONNECT MANUALLY</Text><View style={styles.dividerLine} /></View>
        <Text style={styles.fieldLabel}>PC ADDRESS</Text>
        <TextInput value={manualAddress} onChangeText={setManualAddress} placeholder="192.168.1.20 or 192.168.1.20:8557" placeholderTextColor="#9AA39D" style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" returnKeyType="next" />
        <Text style={styles.fieldLabel}>SIX-DIGIT PAIRING CODE</Text>
        <TextInput value={manualCode} onChangeText={(value) => setManualCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" placeholderTextColor="#AAB3AE" style={[styles.input, styles.codeInput]} keyboardType="number-pad" maxLength={6} />
        <Pressable style={styles.secondaryButton} onPress={manualConnect}><Text style={styles.secondaryButtonText}>Connect to PC</Text><Text style={styles.buttonArrow}>↗</Text></Pressable>
        <View style={styles.securityNote}><Text style={styles.securityIcon}>✓</Text><Text style={styles.securityText}>Same trusted Wi-Fi network required. Pair codes expire after 5 minutes and can be used only once. Never connect over public networks.</Text></View>
        <Text style={styles.versionText}>V_CONTROL MOBILE · LOCAL NETWORK SESSION</Text>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>;
  }

  const modeTitle: Record<ControlMode, string> = {
    gamepad: 'Gamepad Controller', keyboard: 'Keyboard Control', mouse: 'Mouse Control', more: 'Settings & Profiles',
  };

  const renderKeyboard = () => <>
    <View style={styles.controlSectionHeader}><Text style={styles.sectionTitle}>KEYBOARD</Text><Text style={styles.sectionHint}>Press and hold to send</Text></View>
    <View style={styles.keyboardPanel}>
      <View style={styles.panelHeadingRow}><Text style={styles.panelLabel}>QUICK KEYS</Text><Text style={styles.profileSaved}>LIVE INPUT</Text></View>
      {KEY_ROWS.map((row, rowIndex) => <View key={rowIndex} style={styles.keyRow}>{row.map((key) => <KeyCap key={key} label={key === 'BACKSPACE' ? '⌫' : key === 'LEFT' ? '←' : key === 'RIGHT' ? '→' : key === 'UP' ? '↑' : key === 'DOWN' ? '↓' : key} code={key} onPress={sendTrackedDesktopInput} wide={key === 'SHIFT' || key === 'BACKSPACE'} />)}</View>)}
      <View style={styles.keyRow}><KeyCap label="ESC" code="ESC" onPress={sendTrackedDesktopInput} wide/><KeyCap label="TAB" code="TAB" onPress={sendTrackedDesktopInput} wide/><KeyCap label="HOME" code="HOME" onPress={sendTrackedDesktopInput} wide/><KeyCap label="END" code="END" onPress={sendTrackedDesktopInput} wide/><KeyCap label="DEL" code="DELETE" onPress={sendTrackedDesktopInput} wide/></View>
      <View style={styles.keyRow}><KeyCap label="SPACE" code="SPACE" onPress={sendTrackedDesktopInput} extraWide/><KeyCap label="ENTER" code="ENTER" onPress={sendTrackedDesktopInput} wide/></View>
    </View>
    <View style={styles.keyboardPanel}>
      <Text style={styles.panelLabel}>TYPE TEXT TO YOUR PC</Text>
      <Text style={styles.profileDescription}>Text is sent to the active Windows application. Password and secure screens may reject simulated input.</Text>
      <View style={styles.typeRow}><TextInput value={typedText} onChangeText={setTypedText} placeholder="Type a message…" placeholderTextColor="#8D9BA8" style={styles.typeInput} returnKeyType="send" onSubmitEditing={() => { if (typedText) { sendDesktop({ action: 'type', text: typedText }); setTypedText(''); Keyboard.dismiss(); } }} /><Pressable style={styles.typeSend} onPress={() => { if (typedText) { sendDesktop({ action: 'type', text: typedText }); setTypedText(''); Keyboard.dismiss(); } }}><Text style={styles.typeSendText}>Send</Text></Pressable></View>
    </View>
  </>;

  const renderMouse = () => <>
    <View style={styles.controlSectionHeader}><Text style={styles.sectionTitle}>TOUCHPAD</Text><Text style={styles.sectionHint}>Drag to move cursor</Text></View>
    <View style={styles.touchpad} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
      onResponderGrant={(event) => { mousePosition.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }; }}
      onResponderMove={(event) => {
        const next = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
        const prev = mousePosition.current; mousePosition.current = next; if (!prev) return;
        const dxRaw = next.x - prev.x;
        const dyRaw = next.y - prev.y;
        // Two-finger swipes scroll the desktop; a single finger controls cursor movement.
        if ((event.nativeEvent.touches?.length ?? 0) > 1) {
          if (dyRaw !== 0) sendDesktop({ action: 'scroll', delta: Math.round(-dyRaw * 8) });
          return;
        }
        const dx = Math.round(dxRaw * 1.65); const dy = Math.round(dyRaw * 1.65);
        if (dx || dy) sendDesktop({ action: 'move', dx, dy });
      }} onResponderRelease={() => { mousePosition.current = null; }} onResponderTerminate={() => { mousePosition.current = null; }}>
      <View style={styles.touchpadIcon}><Text style={styles.touchpadIconText}>⌖</Text></View><Text style={styles.touchpadTitle}>Move cursor</Text><Text style={styles.touchpadHint}>Slide one finger to move · swipe with two fingers to scroll</Text>
    </View>
    <View style={styles.mouseButtonsRow}>
      <Pressable style={({ pressed }) => [styles.mouseClick, pressed && styles.padPressed]} onPressIn={() => sendTrackedDesktopInput({ action: 'mouseButton', button: 'LEFT', down: true })} onPressOut={() => sendTrackedDesktopInput({ action: 'mouseButton', button: 'LEFT', down: false })}><View style={styles.mouseButtonIcon}><Text style={styles.mouseButtonIconText}>L</Text></View><Text style={styles.mouseButtonTitle}>LEFT CLICK</Text><Text style={styles.mouseButtonHint}>Primary</Text></Pressable>
      <Pressable style={({ pressed }) => [styles.mouseClick, pressed && styles.padPressed]} onPressIn={() => sendTrackedDesktopInput({ action: 'mouseButton', button: 'RIGHT', down: true })} onPressOut={() => sendTrackedDesktopInput({ action: 'mouseButton', button: 'RIGHT', down: false })}><View style={styles.mouseButtonIcon}><Text style={styles.mouseButtonIconText}>R</Text></View><Text style={styles.mouseButtonTitle}>RIGHT CLICK</Text><Text style={styles.mouseButtonHint}>Secondary</Text></Pressable>
    </View>
    <View style={styles.scrollControls}><Text style={styles.panelLabel}>SCROLL</Text><Pressable style={styles.scrollButton} onPress={() => sendDesktop({ action: 'scroll', delta: 120 })}><Text style={styles.scrollText}>↑  Scroll up</Text></Pressable><Pressable style={styles.scrollButton} onPress={() => sendDesktop({ action: 'scroll', delta: -120 })}><Text style={styles.scrollText}>↓  Scroll down</Text></Pressable></View>
    <Text style={styles.helperText}>Mouse control works while the PC session is connected. Input is released automatically if the connection drops.</Text>
  </>;

  return <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.container}>
    <View style={styles.appHeader}>
      <BrandMark compact />
      <View style={styles.connectionPill}><View style={[styles.statusDot, styles.greenDot]} /><Text style={styles.connectionText}>CONNECTED</Text></View>
    </View>
    <View style={styles.connectedMeta}>
      <View style={{ flex: 1 }}><Text style={styles.titleSmall}>{modeTitle[mode]}</Text><Text style={styles.connectedAddress}>{pairing?.host}:{pairing?.port}  ·  {latency === null ? 'Measuring latency…' : `${latency} ms latency`}</Text></View>
      <Pressable style={styles.disconnectButton} onPress={disconnect}><Text style={styles.disconnectText}>Disconnect</Text></Pressable>
    </View>

    <KeyboardAvoidingView style={styles.flexFill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView style={styles.controlScroll} contentContainerStyle={styles.controlContent} keyboardShouldPersistTaps="handled">
      {mode === 'gamepad' ? <>
        <View style={styles.profilePanel}>
          <View style={styles.panelHeadingRow}><Text style={styles.panelLabel}>CONTROL PROFILE</Text><Text style={styles.profileSaved}>SAVED LOCALLY</Text></View>
          <View style={styles.profileChoices}>{(['Balanced', 'FPS', 'Racing', 'Flight'] as ControlProfile[]).map((profile) => <Pressable key={profile} onPress={() => setProfileName(profile)} style={[styles.profileChoice, profileName === profile && styles.profileChoiceActive]}><Text style={[styles.profileChoiceText, profileName === profile && styles.profileChoiceTextActive]}>{profile}</Text></Pressable>)}</View>
          <Text style={styles.profileDescription}>{profileName === 'Balanced' ? 'Standard response · 1.0× stick sensitivity' : profileName === 'FPS' ? 'Faster stick response · 1.25× sensitivity' : profileName === 'Racing' ? 'Smoother stick response · 0.9× sensitivity' : 'Flight-style camera control · inverted right-stick Y'}</Text>
        </View>
        <View style={styles.controllerLayoutPanel}>
          <View style={styles.panelHeadingRow}><Text style={styles.panelLabel}>CONTROLLER LAYOUT</Text><View style={styles.layoutSwitch}><Pressable onPress={() => setFaceLayout('xbox')} style={[styles.layoutChoice, faceLayout === 'xbox' && styles.layoutChoiceActive]}><Text style={[styles.layoutChoiceText, faceLayout === 'xbox' && styles.layoutChoiceTextActive]}>Xbox</Text></Pressable><Pressable onPress={() => setFaceLayout('playstation')} style={[styles.layoutChoice, faceLayout === 'playstation' && styles.layoutChoiceActive]}><Text style={[styles.layoutChoiceText, faceLayout === 'playstation' && styles.layoutChoiceTextActive]}>PlayStation</Text></Pressable></View></View>
          <View style={styles.controllerIllustration}>
            <View style={styles.controllerArtBody}>
              <View style={styles.controllerArtGripLeft}/><View style={styles.controllerArtGripRight}/>
              <View style={styles.controllerArtDpadHorizontal}/><View style={styles.controllerArtDpadVertical}/>
              <View style={styles.controllerArtStickLeft}><View style={styles.controllerArtStickInner}/></View>
              <View style={styles.controllerArtStickRight}><View style={styles.controllerArtStickInner}/></View>
              <View style={styles.controllerArtFaceCluster}><View style={styles.controllerArtButton}/><View style={styles.controllerArtButton}/><View style={styles.controllerArtButton}/><View style={styles.controllerArtButton}/></View>
              <View style={styles.controllerArtCenterBadge}><Text style={styles.controllerArtCenterText}>V</Text></View>
            </View>
          </View>
          <View style={styles.shoulderRow}>
            <Pressable onPressIn={() => setButton('LB', true)} onPressOut={() => setButton('LB', false)} style={({ pressed }) => [styles.shoulderButton, pressed && styles.padPressed]}><Text style={styles.shoulderCode}>LB</Text><Text style={styles.shoulderLabel}>BUMPER</Text></Pressable>
            <Pressable onPressIn={() => setTrigger('leftTrigger', true)} onPressOut={() => setTrigger('leftTrigger', false)} style={({ pressed }) => [styles.triggerButton, pressed && styles.padPressed]}><Text style={styles.shoulderCode}>LT</Text><Text style={styles.shoulderLabel}>TRIGGER</Text></Pressable>
            <View style={{ flex: 1 }} />
            <Pressable onPressIn={() => setTrigger('rightTrigger', true)} onPressOut={() => setTrigger('rightTrigger', false)} style={({ pressed }) => [styles.triggerButton, pressed && styles.padPressed]}><Text style={styles.shoulderCode}>RT</Text><Text style={styles.shoulderLabel}>TRIGGER</Text></Pressable>
            <Pressable onPressIn={() => setButton('RB', true)} onPressOut={() => setButton('RB', false)} style={({ pressed }) => [styles.shoulderButton, pressed && styles.padPressed]}><Text style={styles.shoulderCode}>RB</Text><Text style={styles.shoulderLabel}>BUMPER</Text></Pressable>
          </View>
          <View style={styles.sticksRow}>
            <Stick title="LEFT STICK" x={axes.leftX} y={axes.leftY} onChange={(x, y) => setStick('left', x, y)} onRelease={() => setStick('left', 0, 0)} />
            <Stick title="RIGHT STICK" x={axes.rightX} y={axes.rightY} onChange={(x, y) => setStick('right', x, y)} onRelease={() => setStick('right', 0, 0)} />
          </View>
          <View style={styles.controllerGrid}>
            <View style={styles.controlPanel}><Text style={styles.panelLabel}>D-PAD</Text><View style={styles.dpad}><View style={styles.dpadRow}><PadButton label="↑" code="UP" onPress={setButton} shape="dpad"/></View><View style={styles.dpadRow}><PadButton label="←" code="LEFT" onPress={setButton} shape="dpad"/><View style={styles.dpadCenter}/><PadButton label="→" code="RIGHT" onPress={setButton} shape="dpad"/></View><View style={styles.dpadRow}><PadButton label="↓" code="DOWN" onPress={setButton} shape="dpad"/></View></View></View>
            <View style={styles.controlPanel}><Text style={styles.panelLabel}>ACTION BUTTONS</Text><View style={styles.faceGrid}>
              <View style={styles.faceRow}><View style={{ width: 50 }}/><PadButton label={faceLabels.Y} code="Y" onPress={setButton} color="#F5DE91"/></View>
              <View style={styles.faceRow}><PadButton label={faceLabels.X} code="X" onPress={setButton} color="#A9CEF7"/><View style={{ width: 6 }}/><PadButton label={faceLabels.B} code="B" onPress={setButton} color="#F3B0B0"/></View>
              <View style={styles.faceRow}><View style={{ width: 50 }}/><PadButton label={faceLabels.A} code="A" onPress={setButton} color="#A7DDB7"/></View>
            </View></View>
          </View>
          <View style={styles.utilityRow}><PadButton label="BACK" code="BACK" onPress={setButton} shape="utility"/><PadButton label="L3" code="L3" onPress={setButton} shape="utility"/><PadButton label="START" code="START" onPress={setButton} shape="utility"/><PadButton label="R3" code="R3" onPress={setButton} shape="utility"/></View>
        </View>
        <Text style={styles.helperText}>Layout selection changes the face-button labels; input is still mapped to the Windows Xbox 360 virtual controller.</Text>
      </> : mode === 'keyboard' ? renderKeyboard() : mode === 'mouse' ? renderMouse() : <>
        <View style={styles.moreCard}><Text style={styles.panelLabel}>CONNECTION</Text><Text style={styles.moreTitle}>Connected to your PC</Text><Text style={styles.profileDescription}>Host: {pairing?.host}:{pairing?.port}</Text><Text style={styles.profileDescription}>Latency: {latency === null ? 'Measuring…' : `${latency} ms`}</Text><Text style={styles.profileDescription}>Session uses your trusted local Wi-Fi network.</Text></View>
        <View style={styles.moreCard}><Text style={styles.panelLabel}>CONTROL PROFILE</Text><View style={styles.profileChoices}>{(['Balanced', 'FPS', 'Racing', 'Flight'] as ControlProfile[]).map((profile) => <Pressable key={profile} onPress={() => setProfileName(profile)} style={[styles.profileChoice, profileName === profile && styles.profileChoiceActive]}><Text style={[styles.profileChoiceText, profileName === profile && styles.profileChoiceTextActive]}>{profile}</Text></Pressable>)}</View><Text style={styles.profileDescription}>{profileName} profile is saved on this phone.</Text></View>
        <View style={styles.moreCard}><Text style={styles.panelLabel}>CONTROLLER FACE LABELS</Text><View style={styles.layoutSwitchWide}><Pressable onPress={() => setFaceLayout('xbox')} style={[styles.layoutChoice, faceLayout === 'xbox' && styles.layoutChoiceActive]}><Text style={[styles.layoutChoiceText, faceLayout === 'xbox' && styles.layoutChoiceTextActive]}>Xbox A/B/X/Y</Text></Pressable><Pressable onPress={() => setFaceLayout('playstation')} style={[styles.layoutChoice, faceLayout === 'playstation' && styles.layoutChoiceActive]}><Text style={[styles.layoutChoiceText, faceLayout === 'playstation' && styles.layoutChoiceTextActive]}>PlayStation symbols</Text></Pressable></View><Text style={styles.profileDescription}>The PC virtual controller remains Xbox-compatible; this option changes the button symbols shown in the app.</Text></View>
        <Pressable style={styles.disconnectWide} onPress={disconnect}><Text style={styles.disconnectText}>Disconnect from PC</Text></Pressable>
        <Text style={styles.helperText}>V_Control runs on your private network. Never expose the WebSocket port to the public internet.</Text>
      </>}
      <View style={styles.bottomConnection}><View style={styles.bottomConnectionTop}><View style={[styles.statusDot, styles.greenDot]} /><Text style={styles.bottomConnectionTitle}>Connected · input ready</Text><Text style={styles.bottomLatency}>{latency === null ? '— ms' : `${latency} ms`}</Text></View><Text style={styles.bottomConnectionHint}>Keep V_Control open and both devices on the same Wi-Fi. The PC releases held input if the session drops.</Text></View>
    </ScrollView>
    <View style={styles.bottomNav}>
      <Pressable onPress={() => changeMode('gamepad')} style={[styles.navItem, mode === 'gamepad' && styles.navItemActive]}><Text style={[styles.navIcon, mode === 'gamepad' && styles.navIconActive]}>◎</Text><Text style={[styles.navLabel, mode === 'gamepad' && styles.navLabelActive]}>Gamepad</Text></Pressable>
      <Pressable onPress={() => changeMode('keyboard')} style={[styles.navItem, mode === 'keyboard' && styles.navItemActive]}><Text style={[styles.navIcon, mode === 'keyboard' && styles.navIconActive]}>⌨</Text><Text style={[styles.navLabel, mode === 'keyboard' && styles.navLabelActive]}>Keyboard</Text></Pressable>
      <Pressable onPress={() => changeMode('mouse')} style={[styles.navItem, mode === 'mouse' && styles.navItemActive]}><Text style={[styles.navIcon, mode === 'mouse' && styles.navIconActive]}>▱</Text><Text style={[styles.navLabel, mode === 'mouse' && styles.navLabelActive]}>Mouse</Text></Pressable>
      <Pressable onPress={() => changeMode('more')} style={[styles.navItem, mode === 'more' && styles.navItemActive]}><Text style={[styles.navIcon, mode === 'more' && styles.navIconActive]}>⋯</Text><Text style={[styles.navLabel, mode === 'more' && styles.navLabelActive]}>More</Text></Pressable>
    </View>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <View style={styles.brandRow}><View style={[styles.brandIcon, compact && styles.brandIconCompact]}><Text style={[styles.brandIconText, compact && styles.brandIconTextCompact]}>V</Text></View><View><Text style={styles.brandName}>V_CONTROL</Text>{!compact ? <Text style={styles.brandCaption}>WIRELESS INPUT SYSTEM</Text> : null}</View></View>;
}

function PadButton({ label, code, onPress, shape = 'action', color }: { label: string; code: string; onPress: (code: string, down: boolean) => void; shape?: 'dpad' | 'action' | 'utility'; color?: string }) {
  return <Pressable onPressIn={() => onPress(code, true)} onPressOut={() => onPress(code, false)} style={({ pressed }) => [
    styles.padButton,
    shape === 'dpad' && styles.padDpad,
    shape === 'utility' && styles.padUtility,
    shape === 'action' && styles.padAction,
    color ? { backgroundColor: color } : null,
    pressed && styles.padPressed,
  ]}><Text style={[styles.padButtonText, shape === 'utility' && styles.padUtilityText]}>{label}</Text></Pressable>;
}

function Stick({ title, x, y, onChange, onRelease }: { title: string; x: number; y: number; onChange: (x: number, y: number) => void; onRelease: () => void }) {
  const center = 53;
  const radius = 34;
  const readPoint = (event: any) => {
    const cx = event.nativeEvent.locationX - center;
    const cy = event.nativeEvent.locationY - center;
    const length = Math.sqrt(cx * cx + cy * cy);
    const scale = length > radius ? radius / length : 1;
    onChange(Math.max(-1, Math.min(1, cx * scale / radius)), Math.max(-1, Math.min(1, cy * scale / radius)));
  };
  return <View style={styles.stickColumn}><View style={styles.stickSurface} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
      onResponderGrant={readPoint} onResponderMove={readPoint} onResponderRelease={onRelease} onResponderTerminate={onRelease}>
      <View style={styles.stickRing} /><View style={styles.stickCrossH}/><View style={styles.stickCrossV}/><View style={[styles.stickKnob, { left: center - 18 + x * radius, top: center - 18 + y * radius }]}><View style={styles.stickKnobInner}/></View>
    </View><Text style={styles.stickTitle}>{title}</Text><Text style={styles.stickValue}>{x.toFixed(2)} · {y.toFixed(2)}</Text></View>;
}

function KeyCap({ label, code, onPress, wide = false, extraWide = false }: { label: string; code: string; onPress: (command: Omit<DesktopCommand, 'type'>) => void; wide?: boolean; extraWide?: boolean }) {
  return <Pressable onPressIn={() => onPress({ action: 'key', key: code, down: true })} onPressOut={() => onPress({ action: 'key', key: code, down: false })} style={({ pressed }) => [styles.keyCap, wide && styles.keyCapWide, extraWide && styles.keyCapExtraWide, pressed && styles.keyCapPressed]}><Text style={[styles.keyCapText, label.length > 5 && styles.keyCapSmallText]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F1F4F7' },
  flexFill: { flex: 1 },
  connectContent: { paddingHorizontal: 21, paddingTop: 20, paddingBottom: 30 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandIcon: { width: 40, height: 40, borderRadius: 11, backgroundColor: '#E3E8EE', borderWidth: 1, borderColor: '#D6DEE7', alignItems: 'center', justifyContent: 'center' },
  brandIconCompact: { width: 34, height: 34, borderRadius: 9 },
  brandIconText: { color: '#667F96', fontSize: 24, fontFamily: 'Doto', fontWeight: '900' },
  brandIconTextCompact: { fontSize: 20 },
  brandName: { color: '#26394B', fontSize: 15, fontFamily: 'Doto', fontWeight: '900', letterSpacing: 1.1 },
  brandCaption: { marginTop: 3, color: '#8494A4', fontSize: 8, letterSpacing: 1.2, fontWeight: '700' },
  heroBlock: { marginTop: 27, marginBottom: 20 },
  heroIcon: { width: 48, height: 48, borderRadius: 14, backgroundColor: '#E8EDF2', alignItems: 'center', justifyContent: 'center', marginBottom: 14, borderWidth: 1, borderColor: '#D9E2EA' },
  heroIconText: { color: '#71869A', fontSize: 31, fontWeight: '300' },
  title: { color: '#26394B', fontSize: 28, lineHeight: 35, letterSpacing: -0.5, fontWeight: '800' },
  subtitle: { color: '#718191', fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: 410 },
  statusCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 13, borderWidth: 1, borderColor: '#DCE4EC', padding: 15, marginBottom: 14 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 }, greenDot: { backgroundColor: '#15945B' }, amberDot: { backgroundColor: '#8793A1' }, silverDot: { backgroundColor: '#8793A1' },
  cardTitle: { color: '#2B4054', fontSize: 13, fontWeight: '800' }, statusMessage: { color: '#748494', fontSize: 11, lineHeight: 17, marginTop: 4 }, monoSmall: { color: '#778B9E', fontSize: 18 },
  primaryButton: { minHeight: 49, backgroundColor: '#71869A', borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#697E91' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800', letterSpacing: 0.1 },
  cameraCard: { height: 292, overflow: 'hidden', borderRadius: 15, backgroundColor: '#323E4A', marginBottom: 5 },
  scanFrame: { ...StyleSheet.absoluteFill, margin: 42 },
  scanCornerTL: { position: 'absolute', left: 0, top: 0, width: 28, height: 28, borderTopWidth: 3, borderLeftWidth: 3, borderColor: '#DCE4EC', borderTopLeftRadius: 7 },
  scanCornerTR: { position: 'absolute', right: 0, top: 0, width: 28, height: 28, borderTopWidth: 3, borderRightWidth: 3, borderColor: '#DCE4EC', borderTopRightRadius: 7 },
  scanCornerBL: { position: 'absolute', left: 0, bottom: 0, width: 28, height: 28, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: '#DCE4EC', borderBottomLeftRadius: 7 },
  scanCornerBR: { position: 'absolute', right: 0, bottom: 0, width: 28, height: 28, borderBottomWidth: 3, borderRightWidth: 3, borderColor: '#DCE4EC', borderBottomRightRadius: 7 },
  cancelScan: { position: 'absolute', bottom: 12, alignSelf: 'center', backgroundColor: '#243342EE', borderRadius: 9, paddingVertical: 11, paddingHorizontal: 20 }, cancelScanText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  orDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 19 }, dividerLine: { height: 1, flex: 1, backgroundColor: '#D9E2EA' }, orText: { color: '#8796A4', fontSize: 8, letterSpacing: 1.25, fontWeight: '800' },
  fieldLabel: { color: '#718395', fontSize: 9, fontWeight: '800', letterSpacing: 1.15, marginBottom: 7 },
  input: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D7E0E8', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12, color: '#293F53', fontSize: 13, marginBottom: 14 },
  codeInput: { fontFamily: 'Doto', fontSize: 19, letterSpacing: 4, fontWeight: '700' },
  secondaryButton: { flexDirection: 'row', minHeight: 46, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D5DFE8', borderRadius: 10 },
  secondaryButtonText: { color: '#3C5368', fontWeight: '800', fontSize: 12 }, buttonArrow: { color: '#71869A', fontSize: 16, marginLeft: 8 },
  securityNote: { flexDirection: 'row', gap: 10, backgroundColor: '#E9EEF3', borderColor: '#D9E2EA', borderWidth: 1, borderRadius: 11, padding: 12, marginTop: 17 }, securityIcon: { color: '#657D93', fontSize: 13, fontWeight: '900' }, securityText: { flex: 1, color: '#677B8D', fontSize: 10, lineHeight: 16 },
  versionText: { color: '#92A0AD', textAlign: 'center', fontSize: 8, letterSpacing: 1.2, marginTop: 19, fontWeight: '700' },
  appHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 17, paddingTop: 8, paddingBottom: 5, backgroundColor: '#FFFFFF' },
  connectionPill: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#F4F8F6', borderWidth: 1, borderColor: '#D8E9E0', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 30 }, connectionText: { color: '#178653', fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },
  connectedMeta: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 13, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#DCE4EC' },
  titleSmall: { color: '#26394B', fontSize: 21, fontWeight: '800', letterSpacing: -0.3 }, connectedAddress: { color: '#81909E', fontSize: 9, marginTop: 4, fontFamily: 'Doto' },
  disconnectButton: { borderColor: '#E9D9DC', borderWidth: 1, backgroundColor: '#FFF9FA', paddingHorizontal: 11, paddingVertical: 9, borderRadius: 9 }, disconnectText: { color: '#C63B46', fontWeight: '800', fontSize: 10 }, disconnectWide: { marginTop: 3, borderColor: '#E8D4D8', borderWidth: 1, backgroundColor: '#FFF8F9', alignItems: 'center', paddingVertical: 13, borderRadius: 11 },
  controlScroll: { flex: 1 }, controlContent: { paddingHorizontal: 15, paddingTop: 12, paddingBottom: 15 },
  controlSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 3, marginBottom: 10 }, sectionTitle: { color: '#6F8294', fontSize: 9, letterSpacing: 1.2, fontWeight: '900' }, sectionHint: { color: '#8C9AA8', fontSize: 9 },
  profilePanel: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE4EC', borderRadius: 13, padding: 12, marginBottom: 12 }, profileSaved: { color: '#8797A5', fontSize: 7, fontWeight: '900', letterSpacing: 0.7 }, profileChoices: { flexDirection: 'row', gap: 6, marginTop: 9 }, profileChoice: { flex: 1, minWidth: 0, paddingVertical: 9, paddingHorizontal: 3, alignItems: 'center', borderRadius: 8, backgroundColor: '#F1F4F7', borderWidth: 1, borderColor: '#E0E7ED' }, profileChoiceActive: { backgroundColor: '#DCE5ED', borderColor: '#B9C8D6' }, profileChoiceText: { color: '#758697', fontSize: 9, fontWeight: '700' }, profileChoiceTextActive: { color: '#354F66', fontWeight: '900' }, profileDescription: { color: '#81909F', fontSize: 9, lineHeight: 14, marginTop: 8 },
  controllerLayoutPanel: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE4EC', borderRadius: 14, padding: 11, marginBottom: 12 }, layoutSwitch: { flexDirection: 'row', backgroundColor: '#EFF3F6', borderRadius: 8, padding: 3, gap: 3 }, layoutSwitchWide: { flexDirection: 'row', backgroundColor: '#EFF3F6', borderRadius: 8, padding: 3, gap: 3, marginTop: 10 }, layoutChoice: { flex: 1, alignItems: 'center', paddingHorizontal: 9, paddingVertical: 7, borderRadius: 6 }, layoutChoiceActive: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D2DCE5' }, layoutChoiceText: { color: '#7B8B9A', fontSize: 9, fontWeight: '700' }, layoutChoiceTextActive: { color: '#3C566D', fontWeight: '900' },
  controllerIllustration: { height: 113, alignItems: 'center', justifyContent: 'center', marginTop: 5, marginBottom: 1 }, controllerArtBody: { width: '86%', height: 67, borderRadius: 30, backgroundColor: '#E5EBF1', borderWidth: 1, borderColor: '#BDCAD6', position: 'relative', overflow: 'visible' }, controllerArtGripLeft: { position: 'absolute', width: 47, height: 54, left: 8, bottom: -24, borderRadius: 20, backgroundColor: '#E5EBF1', borderWidth: 1, borderColor: '#BDCAD6', transform: [{ rotate: '12deg' }] }, controllerArtGripRight: { position: 'absolute', width: 47, height: 54, right: 8, bottom: -24, borderRadius: 20, backgroundColor: '#E5EBF1', borderWidth: 1, borderColor: '#BDCAD6', transform: [{ rotate: '-12deg' }] }, controllerArtDpadHorizontal: { position: 'absolute', width: 34, height: 10, left: 21, top: 27, borderRadius: 3, backgroundColor: '#8192A3' }, controllerArtDpadVertical: { position: 'absolute', width: 10, height: 34, left: 33, top: 15, borderRadius: 3, backgroundColor: '#8192A3' }, controllerArtStickLeft: { position: 'absolute', left: 74, top: 18, width: 24, height: 24, borderRadius: 12, backgroundColor: '#CBD5DF', borderWidth: 2, borderColor: '#899BAC', alignItems: 'center', justifyContent: 'center' }, controllerArtStickRight: { position: 'absolute', right: 73, top: 28, width: 24, height: 24, borderRadius: 12, backgroundColor: '#CBD5DF', borderWidth: 2, borderColor: '#899BAC', alignItems: 'center', justifyContent: 'center' }, controllerArtStickInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#718397' }, controllerArtFaceCluster: { position: 'absolute', right: 20, top: 11, width: 43, height: 43, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 4 }, controllerArtButton: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#899BAC', borderWidth: 1, borderColor: '#718397' }, controllerArtCenterBadge: { position: 'absolute', top: -1, alignSelf: 'center', width: 21, height: 21, borderRadius: 7, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#C8D3DE', alignItems: 'center', justifyContent: 'center' }, controllerArtCenterText: { color: '#6A7E92', fontSize: 10, fontWeight: '900' },
  sticksRow: { flexDirection: 'row', justifyContent: 'space-around', backgroundColor: '#F8FAFC', borderRadius: 13, paddingVertical: 12, borderWidth: 1, borderColor: '#E1E8EE', marginVertical: 10 }, stickColumn: { alignItems: 'center', flex: 1 }, stickSurface: { width: 106, height: 106, borderRadius: 53, backgroundColor: '#E7EDF3', borderWidth: 1, borderColor: '#D4DFE8', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, stickRing: { position: 'absolute', width: 74, height: 74, borderRadius: 37, borderWidth: 1, borderColor: '#C8D4DF' }, stickCrossH: { position: 'absolute', height: 1, left: 13, right: 13, backgroundColor: '#D3DDE6' }, stickCrossV: { position: 'absolute', width: 1, top: 13, bottom: 13, backgroundColor: '#D3DDE6' }, stickKnob: { position: 'absolute', width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: '#AAB9C7', backgroundColor: '#C9D3DE', alignItems: 'center', justifyContent: 'center' }, stickKnobInner: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#6D8296' }, stickTitle: { color: '#718496', fontSize: 8, letterSpacing: 0.8, fontWeight: '900', marginTop: 8 }, stickValue: { color: '#8797A5', fontSize: 8, fontFamily: 'Doto', marginTop: 4 },
  shoulderRow: { flexDirection: 'row', gap: 5, alignItems: 'center', marginTop: 10, marginBottom: 2 }, shoulderButton: { width: 56, height: 41, borderRadius: 9, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D9E2EA', alignItems: 'center', justifyContent: 'center' }, triggerButton: { width: 53, height: 41, borderRadius: 9, backgroundColor: '#E8EDF2', borderWidth: 1, borderColor: '#D5DFE8', alignItems: 'center', justifyContent: 'center' }, shoulderCode: { color: '#3F566B', fontSize: 12, fontWeight: '900' }, shoulderLabel: { color: '#8796A4', fontSize: 6, marginTop: 2, letterSpacing: 0.4, fontWeight: '800' },
  controllerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 }, controlPanel: { flex: 1, minWidth: 140, backgroundColor: '#FFFFFF', borderColor: '#DCE4EC', borderWidth: 1, borderRadius: 13, padding: 10, minHeight: 176 }, panelLabel: { color: '#748799', fontSize: 8, fontWeight: '900', letterSpacing: 1.0 }, dpad: { marginTop: 10, alignItems: 'center' }, dpadRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }, dpadCenter: { width: 42 }, faceGrid: { alignItems: 'center', marginTop: 10 }, faceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  padButton: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D3DEE8' }, padDpad: { width: 42, height: 42, borderRadius: 9, backgroundColor: '#E9EEF3' }, padAction: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#E5EAF0' }, padUtility: { flex: 1, height: 36, borderRadius: 9, backgroundColor: '#FFFFFF', paddingHorizontal: 3 }, padPressed: { backgroundColor: '#D1DBE4', borderColor: '#9EAFBE' }, padButtonText: { color: '#40586D', fontSize: 14, fontWeight: '900' }, padUtilityText: { fontSize: 8, letterSpacing: 0.1 },
  utilityRow: { flexDirection: 'row', gap: 7, marginTop: 10 }, helperText: { color: '#8493A1', fontSize: 9, lineHeight: 14, marginHorizontal: 3, marginTop: 12 },
  touchpad: { height: 220, backgroundColor: '#E8EEF4', borderWidth: 1, borderColor: '#D4DFE8', borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, touchpadIcon: { width: 47, height: 47, backgroundColor: '#D9E3EC', borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }, touchpadIconText: { color: '#637B91', fontSize: 32 }, touchpadTitle: { color: '#344D64', fontSize: 14, fontWeight: '800' }, touchpadHint: { color: '#768A9D', fontSize: 9, marginTop: 6, textAlign: 'center', paddingHorizontal: 12 },
  mouseButtonsRow: { flexDirection: 'row', gap: 9, marginTop: 10 }, mouseClick: { flex: 1, borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE4EC', paddingVertical: 13, alignItems: 'center' }, mouseButtonIcon: { width: 25, height: 25, borderRadius: 8, backgroundColor: '#E8EDF2', alignItems: 'center', justifyContent: 'center', marginBottom: 7 }, mouseButtonIconText: { color: '#526C83', fontSize: 10, fontWeight: '900' }, mouseButtonTitle: { color: '#3C5368', fontSize: 9, fontWeight: '900', letterSpacing: 0.4 }, mouseButtonHint: { color: '#8B99A7', fontSize: 8, marginTop: 4 },
  scrollControls: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 15 }, scrollButton: { backgroundColor: '#E6ECF2', borderRadius: 8, paddingVertical: 9, paddingHorizontal: 10 }, scrollText: { color: '#526B81', fontSize: 9, fontWeight: '700' },
  keyboardPanel: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE4EC', borderRadius: 13, padding: 11, marginBottom: 11 }, sectionHintBelow: { color: '#8D9BA8', fontSize: 9, marginTop: 5, marginBottom: 12 }, keyRow: { flexDirection: 'row', gap: 3, justifyContent: 'center', marginBottom: 5 }, keyCap: { flex: 1, minWidth: 0, height: 35, backgroundColor: '#EFF3F6', borderWidth: 1, borderColor: '#DCE4EC', borderRadius: 6, justifyContent: 'center', alignItems: 'center' }, keyCapWide: { flex: 1.4, paddingHorizontal: 2 }, keyCapExtraWide: { flex: 3.5 }, keyCapPressed: { backgroundColor: '#DCE5ED', borderColor: '#ACBDCC' }, keyCapText: { color: '#40576B', fontSize: 9, fontWeight: '800' }, keyCapSmallText: { fontSize: 7 }, fieldLabelWrap: { marginTop: 12 }, typeRow: { flexDirection: 'row', gap: 7, marginTop: 10 }, typeInput: { flex: 1, minWidth: 0, backgroundColor: '#F7F9FB', borderWidth: 1, borderColor: '#D7E0E8', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 10, color: '#2B4054', fontSize: 11 }, typeSend: { backgroundColor: '#71869A', paddingHorizontal: 15, borderRadius: 9, alignItems: 'center', justifyContent: 'center' }, typeSendText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  panelHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, layoutToggle: { color: '#71869A', fontSize: 8, fontWeight: '900' },
  moreCard: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE4EC', borderRadius: 13, padding: 14, marginBottom: 11 }, moreTitle: { color: '#2C4257', fontSize: 16, fontWeight: '800', marginTop: 10 },
  bottomConnection: { backgroundColor: '#EAF0F5', borderColor: '#D9E2EA', borderWidth: 1, borderRadius: 11, marginTop: 15, padding: 12 }, bottomConnectionTop: { flexDirection: 'row', alignItems: 'center', gap: 7 }, bottomConnectionTitle: { color: '#4B6378', fontSize: 10, fontWeight: '900', flex: 1 }, bottomLatency: { color: '#637B90', fontFamily: 'Doto', fontSize: 10, fontWeight: '800' }, bottomConnectionHint: { color: '#748798', fontSize: 9, lineHeight: 14, marginTop: 7 },
  bottomNav: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#D9E2EA', paddingHorizontal: 7, paddingTop: 5, paddingBottom: 3 }, navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 6, minHeight: 48, borderRadius: 9 }, navItemActive: { backgroundColor: '#EEF3F7' }, navIcon: { color: '#7D8D9B', fontSize: 19, lineHeight: 22 }, navIconActive: { color: '#526F88' }, navLabel: { color: '#8796A3', fontSize: 8, fontWeight: '700' }, navLabelActive: { color: '#415D75', fontWeight: '900' },
});
