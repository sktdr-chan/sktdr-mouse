'use strict';

/* =============================================================================
 * マウス設定ツール — schema-driven frontend (multi-device).
 * The UI is rendered entirely from the device profile schemas served by
 * /api/schema (devices/*.json). No mouse-specific code here.
 * ========================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/** Accepts 42, "42", "0x2A" and returns a number (or fallback). */
function num(v, fallback = 0) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x/i.test(s)) {
      const n = parseInt(s.slice(2), 16);
      return Number.isNaN(n) ? fallback : n;
    }
    const n = Number(s);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

/* ------------------------------------------------------------------ state */

let devicesStatus = []; // from /api/status: [{ id, name, connected, online, ... }]
let activeDevice = null;
const slots = {}; // deviceId -> { schema, status, config }
let busy = false;
let resetArmed = null;
let builtFor = null; // schema id the settings DOM was built for
let buildInfo = null; // from /api/build-info

/* ------------------------------------------------------------------ i18n */

const LANGS = ['ja', 'en', 'zh'];
const LANG_NAMES = { ja: '日本語', en: 'English', zh: '中文' };
let lang = LANGS.includes(localStorage.getItem('uiLang') || '') ? localStorage.getItem('uiLang') : 'ja';

const I18N = {
  ja: {
    appTitle: 'sktdr-mouse',
    brandSub: '設定ツール',
    deviceInfo: 'デバイス情報',
    log: 'ログ',
    manage: '管理',
    manageTitle: '対応するマウス',
    manageHint:
      '接続中のマウスが上部に表示されます。非アクティブ（切断・スリープ）になったマウスは灰色になり、1分間再接続されないと自動で消えます。',
    disclaimerShort: '本ソフトは非公式・無保証です。すべて自己責任で使用してください。',
    language: '表示言語',
    battery: 'バッテリー',
    build: 'ビルド',
    applyModeTip: '変更の適用方法：即時適用か、保存ボタンでまとめて適用か',
    applyImmediate: '即時適用',
    applyManual: '保存ボタン',
    apply: '適用',
    applyWithCount: '適用 ({1})',
    applyAllTip: '保留中の変更をデバイスに適用',
    close: '閉じる',
    notConnected: '未接続',
    sleeping: 'スリープ中',
    connected: '接続済み',
    noDevices: '対応デバイスが見つかりません。USB接続すると自動で認識します…',
    deviceNotConnected: '{1} は未接続です。USB接続すると自動で認識します…',
    offlineBanner:
      'マウスがオフラインです。マウスを動かすかクリックしてスリープを解除してください（電源スイッチ・モード切替も確認してください）。',
    saved: '保存しました',
    applied: '適用しました',
    applyFailedSome: '{1} 件失敗しました（保留中）',
    errorPrefix: 'エラー: {1}',
    commError: '通信エラー: {1}',
    readFailed: '読み出し失敗: {1}',
    readDevice: 'デバイスから読み出し',
    readDone: '読み出しました',
    protocolSource: 'プロトコル出典:',
    stageCount: 'ステージ数',
    stagesOption: '{1} 段階',
    activeStage: 'アクティブステージ',
    currentStage: '現在のステージ: {1}',
    stageColor: 'ステージの色',
    use: '使用',
    useTooltip: 'このステージに切り替え',
    inUse: '使用中',
    armedConfirm: '本当に実行する場合、もう一度クリック',
    executed: '実行しました',
    actionRun: '{1} 実行',
    chipSleepSuffix: '（スリープ中）',
    chipOfflineSuffix: '（切断・スリープ）',
    manageConnected: '接続中',
    manageBattery: '残量 {1}%',
    manageNotSeen: '未接続（直前に接続あり）',
    select: '選択',
    shown: '表示中',
    supportedMice: '対応機種: {1}',
    serverDown: 'サーバーに接続できません',
    moveMouse: 'マウスを動かしてスリープを解除してください',
    notifChanged: '{1}: マウス側で設定が変更されました（再取得中…）',
    mouseOfflineLog: 'マウスがスリープ/オフラインになりました',
    overDongleTip: 'このドングルでは無効 — 設定は保存され、対応ドングル接続時に有効になります',
    keepAliveOn: 'スリープ防止ON — 2秒間隔でコマンドを送り続けます',
    keepAliveOff: 'スリープ防止OFF — 通常のスリープ動作に戻りました',
  },
  en: {
    appTitle: 'sktdr-mouse',
    brandSub: 'CONFIG',
    deviceInfo: 'Device Information',
    log: 'Log',
    manage: 'Manage',
    manageTitle: 'Supported Mice',
    manageHint:
      'Connected mice appear in the header. Inactive mice (disconnected or sleeping) turn gray and disappear automatically if they stay offline for one minute.',
    disclaimerShort: 'Unofficial software, provided as-is and without warranty. Use at your own risk.',
    language: 'Language',
    battery: 'Battery',
    build: 'Build',
    applyModeTip: 'How changes are applied: immediately, or all together with the Save button',
    applyImmediate: 'Apply instantly',
    applyManual: 'Save button',
    apply: 'Apply',
    applyWithCount: 'Apply ({1})',
    applyAllTip: 'Apply pending changes to the device',
    close: 'Close',
    notConnected: 'Not connected',
    sleeping: 'Sleeping',
    connected: 'Connected',
    noDevices: 'No supported device found. Connect it via USB and it will be recognized automatically…',
    deviceNotConnected: '{1} is not connected. Connect it via USB and it will be recognized automatically…',
    offlineBanner:
      'The mouse is offline. Move or click it to wake it up (also check the power switch and mode selector).',
    saved: 'Saved',
    applied: 'Applied',
    applyFailedSome: '{1} change(s) failed (kept pending)',
    errorPrefix: 'Error: {1}',
    commError: 'Communication error: {1}',
    readFailed: 'Read failed: {1}',
    readDevice: 'Read settings from device',
    readDone: 'Settings read from the device',
    protocolSource: 'Protocol source:',
    stageCount: 'Number of stages',
    stagesOption: '{1} stage(s)',
    activeStage: 'Active stage',
    currentStage: 'Current stage: {1}',
    stageColor: 'Stage color',
    use: 'Use',
    useTooltip: 'Switch to this stage',
    inUse: 'In use',
    armedConfirm: 'Click again to really execute',
    executed: 'Executed',
    actionRun: '{1} executed',
    chipSleepSuffix: ' (sleeping)',
    chipOfflineSuffix: ' (disconnected / sleeping)',
    manageConnected: 'Connected',
    manageBattery: 'Battery {1}%',
    manageNotSeen: 'Not connected (seen recently)',
    select: 'Select',
    shown: 'Shown',
    supportedMice: 'Supported models: {1}',
    serverDown: 'Cannot connect to the server',
    moveMouse: 'Move the mouse to wake it up',
    notifChanged: '{1}: settings were changed on the mouse (re-reading…)',
    mouseOfflineLog: 'The mouse went to sleep / offline',
    overDongleTip: 'Inactive with this dongle — the value is stored and becomes active with a compatible dongle',
    keepAliveOn: 'Keep-awake ON — sending a command every 2 seconds',
    keepAliveOff: 'Keep-awake OFF — normal sleep behavior restored',
  },
  zh: {
    appTitle: 'sktdr-mouse',
    brandSub: '设置',
    deviceInfo: '设备信息',
    log: '日志',
    manage: '管理',
    manageTitle: '支持的鼠标',
    manageHint:
      '已连接的鼠标显示在顶部。非活动（断开或休眠）的鼠标会变灰，若 1 分钟内未重新连接则会自动消失。',
    disclaimerShort: '本软件为非官方、无保证的软件，请自行承担使用风险。',
    language: '显示语言',
    battery: '电池',
    build: '构建',
    applyModeTip: '更改的应用方式：立即应用，或通过保存按钮统一应用',
    applyImmediate: '立即应用',
    applyManual: '保存按钮',
    apply: '应用',
    applyWithCount: '应用 ({1})',
    applyAllTip: '将挂起的更改应用到设备',
    close: '关闭',
    notConnected: '未连接',
    sleeping: '休眠中',
    connected: '已连接',
    noDevices: '未找到支持的设备。通过 USB 连接后将自动识别…',
    deviceNotConnected: '{1} 未连接。通过 USB 连接后将自动识别…',
    offlineBanner: '鼠标已离线。请移动或点击鼠标以唤醒（也请检查电源开关和模式切换）。',
    saved: '已保存',
    applied: '已应用',
    applyFailedSome: '{1} 项失败（仍保留）',
    errorPrefix: '错误: {1}',
    commError: '通信错误: {1}',
    readFailed: '读取失败: {1}',
    readDevice: '从设备读取设置',
    readDone: '已从鼠标读取设置',
    protocolSource: '协议来源:',
    stageCount: '阶段数量',
    stagesOption: '{1} 档',
    activeStage: '当前阶段',
    currentStage: '当前阶段: {1}',
    stageColor: '阶段颜色',
    use: '使用',
    useTooltip: '切换到此阶段',
    inUse: '使用中',
    armedConfirm: '再次点击以确认执行',
    executed: '已执行',
    actionRun: '{1} 已执行',
    chipSleepSuffix: '（休眠中）',
    chipOfflineSuffix: '（断开 / 休眠）',
    manageConnected: '已连接',
    manageBattery: '电量 {1}%',
    manageNotSeen: '未连接（最近连接过）',
    select: '选择',
    shown: '显示中',
    supportedMice: '支持型号: {1}',
    serverDown: '无法连接到服务器',
    moveMouse: '请移动鼠标以唤醒',
    notifChanged: '{1}: 鼠标端设置已更改（正在重新读取…）',
    mouseOfflineLog: '鼠标已休眠 / 离线',
    overDongleTip: '当前接收器下无效 — 设置已保存，连接支持的接收器后生效',
    keepAliveOn: '防休眠 ON — 每 2 秒发送一次指令',
    keepAliveOff: '防休眠 OFF — 恢复正常休眠行为',
  },
};

function t(key, ...args) {
  const dict = I18N[lang] || I18N.ja;
  let s = dict[key] != null ? dict[key] : (I18N.ja[key] != null ? I18N.ja[key] : key);
  args.forEach((a, i) => {
    s = s.split('{' + (i + 1) + '}').join(String(a));
  });
  return s;
}

/**
 * Translations for labels/texts that live inside the device profile JSONs.
 * Keyed by the profile's Japanese string. Missing entries fall back to the
 * original (Japanese) text, so a new profile keeps working without changes.
 */
const LABEL_I18N = {
  // section titles
  'プロファイル': { en: 'Profile', zh: '配置文件' },
  'DPI設定': { en: 'DPI', zh: 'DPI 设置' },
  'ポーリングレート': { en: 'Polling Rate', zh: '轮询率' },
  'センサー設定': { en: 'Sensor', zh: '传感器设置' },
  'ライト設定': { en: 'Lighting', zh: '灯光设置' },
  'システム': { en: 'System', zh: '系统' },
  '電源管理': { en: 'Power', zh: '电源管理' },
  'デバウンサ': { en: 'Debounce', zh: '去抖时间' },
  // settings / fields
  'DPI': { en: 'DPI', zh: 'DPI' },
  'Lift-off Distance (LOD)': { en: 'Lift-off Distance (LOD)', zh: '抬升距离 (LOD)' },
  'モーションシンク': { en: 'Motion Sync', zh: '运动同步' },
  'アングルスナップ': { en: 'Angle Snap', zh: '角度吸附' },
  'アングルスナッピング': { en: 'Angle Snapping', zh: '角度吸附' },
  'リップルコントロール': { en: 'Ripple Control', zh: '波纹控制' },
  '20Kセンサーモード': { en: '20K Sensor Mode', zh: '20K 传感器模式' },
  'パフォーマンスモード': { en: 'Performance Mode', zh: '性能模式' },
  'センサーモード': { en: 'Sensor Mode', zh: '传感器模式' },
  'センサー高性能モード': { en: 'High-performance Sensor', zh: '传感器高性能模式' },
  'eスポーツモード': { en: 'Esports Mode', zh: '电竞模式' },
  'スリープ時間': { en: 'Sleep Time', zh: '休眠时间' },
  'パフォーマンス時間': { en: 'Performance Time', zh: '性能持续时间' },
  'スリープまでの時間': { en: 'Sleep After', zh: '自动休眠时间' },
  'スクロール方向反転': { en: 'Invert Scroll Direction', zh: '反转滚轮方向' },
  'ライト': { en: 'Lighting', zh: '灯光' },
  'モード': { en: 'Mode', zh: '模式' },
  'カラー': { en: 'Color', zh: '颜色' },
  '速度': { en: 'Speed', zh: '速度' },
  '明るさ': { en: 'Brightness', zh: '亮度' },
  'ロングレンジモード': { en: 'Long Range Mode', zh: '远距离模式' },
  'Ecoモード': { en: 'Eco Mode', zh: '节能模式' },
  'ペアリングモード開始': { en: 'Start Pairing Mode', zh: '开始配对模式' },
  '工場出荷状態に戻す': { en: 'Factory Reset', zh: '恢复出厂设置' },
  'オンボードプロファイルに戻す': { en: 'Return to Onboard Profile', zh: '返回板载配置文件' },
  '再同期（バッテリー照会）': { en: 'Resync (battery query)', zh: '重新同步（电池查询）' },
  '製品': { en: 'Product', zh: '产品' },
  '接続方式': { en: 'Connection', zh: '连接方式' },
  'マウスファームウェア': { en: 'Mouse Firmware', zh: '鼠标固件' },
  'ドングルファームウェア': { en: 'Dongle Firmware', zh: '接收器固件' },
  'ファームウェア': { en: 'Firmware', zh: '固件' },
  '電池電圧': { en: 'Battery Voltage', zh: '电池电压' },
  '現在のプロファイル': { en: 'Current Profile', zh: '当前配置文件' },
  'バッテリー': { en: 'Battery', zh: '电池' },
  // options
  'オフ': { en: 'Off', zh: '关闭' },
  'カラーフロー': { en: 'Color Flow', zh: '色彩流动' },
  '単色ブリージング': { en: 'Breathing (Single Color)', zh: '单色呼吸' },
  '常時点灯（単色）': { en: 'Steady (Single Color)', zh: '常亮（单色）' },
  'ネオン': { en: 'Neon', zh: '霓虹' },
  '混色ブリージング': { en: 'Breathing (Multi Color)', zh: '混色呼吸' },
  '常時点灯（フルカラー）': { en: 'Steady (Full Color)', zh: '常亮（全彩）' },
  '単色 常時点灯': { en: 'Single Color (Steady)', zh: '单色常亮' },
  '単色 ブリージング': { en: 'Single Color (Breathing)', zh: '单色呼吸' },
  'フルカラーサイクル': { en: 'Full Color Cycle', zh: '全彩循环' },
  '単色フロー': { en: 'Single Color Flow', zh: '单色流动' },
  'ネオンフラッシュ': { en: 'Neon Flash', zh: '霓虹闪烁' },
  '省電力 (LP)': { en: 'Power Saving (LP)', zh: '省电 (LP)' },
  '高性能 (HP)': { en: 'High Performance (HP)', zh: '高性能 (HP)' },
  '低 (0.7mm)': { en: 'Low (0.7mm)', zh: '低 (0.7mm)' },
  '中 (1mm)': { en: 'Medium (1mm)', zh: '中 (1mm)' },
  '高 (2mm)': { en: 'High (2mm)', zh: '高 (2mm)' },
  '非常に低い Very Low': { en: 'Very Low', zh: '极低' },
  '低い Low': { en: 'Low', zh: '低' },
  // connection labels
  'USB有線': { en: 'USB wired', zh: 'USB 有线' },
  '有線接続': { en: 'Wired', zh: '有线连接' },
  'ワイヤレス (8Kドングル)': { en: 'Wireless (8K dongle)', zh: '无线 (8K 接收器)' },
  'ワイヤレス (Lightspeed)': { en: 'Wireless (Lightspeed)', zh: '无线 (Lightspeed)' },
  'ワイヤレス (最大1K)': { en: 'Wireless (up to 1K)', zh: '无线 (最高 1K)' },
  'ワイヤレス 4K': { en: 'Wireless 4K', zh: '无线 4K' },
  '有線 (最大1K)': { en: 'Wired (up to 1K)', zh: '有线 (最高 1K)' },
  '有線 8K': { en: 'Wired 8K', zh: '有线 8K' },
  'ワイヤレス 2K': { en: 'Wireless 2K', zh: '无线 2K' },
  'ワイヤレス 8K': { en: 'Wireless 8K', zh: '无线 8K' },
  'スリープ中': { en: 'Sleeping', zh: '休眠中' },
  '接続済み': { en: 'Connected', zh: '已连接' },
  'プロファイル 1': { en: 'Profile 1', zh: '配置文件 1' },
  'プロファイル 2': { en: 'Profile 2', zh: '配置文件 2' },
  'プロファイル 3': { en: 'Profile 3', zh: '配置文件 3' },
  'プロファイル 4': { en: 'Profile 4', zh: '配置文件 4' },
  'プロファイル 5': { en: 'Profile 5', zh: '配置文件 5' },
  'デバイスから設定を読み出す': { en: 'Read settings from device', zh: '从设备读取设置' },
  'マウス本体のフラッシュから全設定（DPI・ポーリングレート・センサー設定など）を再読み込みします。マウス本体のボタンで設定を変えた後の同期に便利です。': {
    en: 'Re-reads all settings (DPI, polling rate, sensor options, …) from the mouse flash. Useful to re-sync after changing settings with the buttons on the mouse.',
    zh: '从鼠标闪存重新读取全部设置（DPI、轮询率、传感器选项等）。在通过鼠标按键更改设置后同步时很方便。',
  },
  '本機はプロトコル上、設定の読み戻しに対応していません（公式Swarmも読み出せません）。このボタンはデバイスへのバッテリー照会で生存確認を行い、このツールが保持する設定キャッシュ（最後に書き込んだ値）を表示します。': {
    en: 'This device cannot read settings back over the protocol (the official Swarm cannot either). This button only queries the battery to confirm the device is alive and shows the settings cache this tool keeps (the last values written).',
    zh: '该设备在协议上不支持回读设置（官方 Swarm 也无法读取）。此按钮仅通过电池查询确认设备存活，并显示本工具保存的设置缓存（最后写入的值）。',
  },
  'マウス本体から全設定（DPI・ポーリングレート・センサー設定など）を再読み込みします。マウス本体のボタンで設定を変えた後の同期に便利です。': {
    en: 'Re-reads all settings (DPI, polling rate, sensor options, …) from the mouse. Useful to re-sync after changing settings with the mouse buttons.',
    zh: '从鼠标重新读取全部设置（DPI、轮询率、传感器选项等）。在通过鼠标按键更改设置后同步时很方便。',
  },
  'マウス本体から全設定（DPI・ポーリングレート・センサー設定・ライト）を再読み込みします。': {
    en: 'Re-reads all settings (DPI, polling rate, sensor, lighting) from the mouse.',
    zh: '从鼠标重新读取全部设置（DPI、轮询率、传感器、灯光）。',
  },
  '再同期しました（デバイス応答OK・設定はこのツールの記録値）': {
    en: 'Resynced (device responded; settings are the values recorded by this tool)',
    zh: '已重新同步（设备响应正常；设置为本工具记录的值）',
  },
  // hints (exact profile strings)
  'プロファイルごとに設定一式（DPI・ポーリングレート等）を保存できます。': {
    en: 'Each profile stores a complete set of settings (DPI, polling rate, …).',
    zh: '每个配置文件可保存一整套设置（DPI、轮询率等）。',
  },
  'DPIは50〜26000の範囲で50刻み。マウス本体のDPIボタンでステージを切り替えると、この画面に自動反映されます。': {
    en: 'DPI ranges from 50 to 26000 in steps of 50. Switching stages with the mouse DPI button is reflected here automatically.',
    zh: 'DPI 范围 50 至 26000，步进 50。使用鼠标 DPI 按键切换阶段时，此处会自动更新。',
  },
  'この接続方式での最大ポーリングレート: {maxHz} Hz': {
    en: 'Max polling rate for this connection: {maxHz} Hz',
    zh: '此连接方式的最大轮询率: {maxHz} Hz',
  },
  'マウス本体は最大 {mouseMaxHz} Hz 対応です。現在のドングルでは最大 {maxHz} Hz までが有効 — {maxHz} Hz を超える設定（点線表示）は保存のみ行われ、対応ドングルに交換すると自動的に有効になります。': {
    en: 'The mouse supports up to {mouseMaxHz} Hz. The current dongle caps it at {maxHz} Hz — settings above {maxHz} Hz (dashed) are stored but only take effect with a compatible dongle.',
    zh: '鼠标本体最高支持 {mouseMaxHz} Hz。当前接收器最高支持 {maxHz} Hz — 超过 {maxHz} Hz 的设置（虚线）仅被保存，更换支持的接收器后自动生效。',
  },
  '0〜255の生値で指定します（参照実装ではテーブル変換なし）': {
    en: 'Raw value 0–255 (no table conversion, matching the reference implementation).',
    zh: '以 0–255 原始值指定（参照实现不做表转换）。',
  },
  '受信感度優先・消費電力増。非対応ファームウェアでは自動的に非表示になります。': {
    en: 'Prioritizes reception sensitivity; higher power draw. Hidden automatically on unsupported firmware.',
    zh: '优先接收灵敏度，功耗增加。不支持的固件会自动隐藏此项。',
  },
  'ペアリングモード開始 — マウスの電源を入れ直して近づけてください': {
    en: 'Pairing mode started — power-cycle the mouse and hold it near the receiver',
    zh: '已进入配对模式 — 请重新打开鼠标电源并靠近接收器',
  },
  '工場リセットを実行しました': { en: 'Factory reset executed', zh: '已执行恢复出厂设置' },
  'DPIは50〜26000の範囲で50刻み。X/Y独立ですが同じ値で書き込まれます。': {
    en: 'DPI 50–26000 in steps of 50. X/Y are independent but written with the same value.',
    zh: 'DPI 范围 50–26000，步进 50。X/Y 独立，但写入相同数值。',
  },
  'センサーを常時高性能状態に保ちます（消費電力増）。': {
    en: 'Keeps the sensor in its high-performance state (higher power draw).',
    zh: '使传感器保持高性能状态（功耗增加）。',
  },
  'DPIが9000超のときのリップルを抑制します。': {
    en: 'Suppresses ripple when DPI is above 9000.',
    zh: '抑制 DPI 超过 9000 时的波纹。',
  },
  'センサーと制御チップを最も活性な状態にします。消費電力が大幅に増加します。ポーリングレート2kHz超では自動有効化されます。': {
    en: 'Puts the sensor and control chip into their most active state. Power consumption increases significantly. Enabled automatically above 2 kHz polling.',
    zh: '使传感器与控制芯片处于最活跃状态。功耗显著增加。轮询率超过 2 kHz 时自动启用。',
  },
  '無操作でスリープするまでの時間（既定600秒 = 10分）': {
    en: 'Time until the mouse sleeps when idle (default 600 s = 10 min).',
    zh: '无操作后进入休眠的时间（默认 600 秒 = 10 分钟）。',
  },
  '低くするとダブルクリックが発生することがあります。': {
    en: 'Lower values may cause double clicks.',
    zh: '数值过低可能导致双击。',
  },
  'カラーは全3ゾーン（ロゴ・ホイール・底部）に同時適用されます。': {
    en: 'The color applies to all three zones (logo, wheel, bottom) at once.',
    zh: '颜色同时应用于全部 3 个区域（Logo、滚轮、底部）。',
  },
  '1〜255の生値で指定します': { en: 'Raw value 1–255', zh: '以 1–255 原始值指定' },
  '100〜25600（50刻み、端数は自動で50刻みに丸められます）。変更は即時適用されます。': {
    en: '100–25600 (steps of 50; values snap to the nearest step). Changes apply immediately.',
    zh: '100–25600（步进 50，自动取整）。更改立即生效。',
  },
  '本体は最大1000Hzです。': { en: 'The mouse supports up to 1000 Hz.', zh: '鼠标最高支持 1000 Hz。' },
  'このツールでの変更（DPI・レート）はライブ適用のため、マウスの電源再投入やこのボタンでオンボードプロファイルの設定に戻ります。G HUBで保存した値を復元したいときに押してください。': {
    en: 'Changes made here (DPI, rate) are applied live and revert to the onboard profile on power-cycle or when pressing this button. Use it to restore the values saved with G HUB.',
    zh: '此处的更改（DPI、轮询率）为即时应用，重新上电或按下此按钮后恢复为板载配置文件。用于还原 G HUB 保存的数值。',
  },
  'マウス本体のオンボードプロファイルに戻しました': {
    en: 'Returned to the mouse onboard profile',
    zh: '已恢复为鼠标板载配置文件',
  },
  '100〜35000（50刻み）。X/Y独立領域に同じ値を書き込みます。変更は即時適用・保存されます。': {
    en: '100–35000 (steps of 50). The same value is written to the X and Y fields. Changes apply immediately and are saved.',
    zh: '100–35000（步进 50）。X/Y 独立字段写入相同数值。更改立即生效并保存。',
  },
  '有線標準ファームウェアでは125/500/1000Hzに対応します。': {
    en: 'The wired standard firmware supports 125 / 500 / 1000 Hz.',
    zh: '有线标准固件支持 125 / 500 / 1000 Hz。',
  },
  '無操作でスリープするまでの時間（60〜900秒）': {
    en: 'Time until sleep when idle (60–900 s).',
    zh: '无操作后进入休眠的时间（60–900 秒）。',
  },
  '5つのDPIスロット（未使用は0のまま）。「使用」ボタンでアクティブステージを切り替えると、そのステージのDPIがすぐ体感できます。': {
    en: 'Five DPI slots (unused ones stay 0). Press "Use" to make a stage active and feel its DPI immediately.',
    zh: '5 个 DPI 槽位（未使用保持 0）。按「使用」切换当前阶段即可立即感受该 DPI。',
  },
  '対応は1000Hzまで。コードはSwarm通信と数値照合済み（125→3, 500→1, 1000→0）。': {
    en: 'Supports up to 1000 Hz. Codes verified against Swarm traffic (125→3, 500→1, 1000→0).',
    zh: '最高支持 1000 Hz。代码已与 Swarm 通信核对（125→3, 500→1, 1000→0）。',
  },
  'Swarm表示と照合済み（コード7=Very Low=既定、コード6=Low）。Swarmにはさらに「カスタム」設定が存在します（符号化は未解明のため本ツールでは未対応）。': {
    en: 'Verified against Swarm (code 7 = Very Low = default, 6 = Low). Swarm also has a "Custom" option (encoding unknown; not supported here).',
    zh: '已与 Swarm 核对（代码 7 = Very Low = 默认，6 = Low）。Swarm 还有「自定义」选项（编码未知，本工具暂不支持）。',
  },
  'ON/OFFは通信解析で確認済み（OFF=0x00, ON=0xaa）。Ecoモード中はセンサー感度・ポーリング等が省電力側に制限される場合があります。': {
    en: 'ON/OFF verified from traffic (OFF=0x00, ON=0xaa). In Eco mode sensor sensitivity and polling may be limited for power saving.',
    zh: 'ON/OFF 已由通信解析确认（OFF=0x00, ON=0xaa）。节能模式下传感器灵敏度与轮询率可能受限。',
  },
  '0〜10ms。Swarm通信と数値照合済み（8ms→08, 4ms→04）。': {
    en: '0–10 ms. Verified against Swarm traffic (8 ms→08, 4 ms→04).',
    zh: '0–10ms。已与 Swarm 通信核对（8ms→08, 4ms→04）。',
  },
  '8スロット固定。DPIはX/Y独立ですが、本ツールはX=Yとして書き込みます（レンジ100〜30000、50刻み）。マウスのDPIボタンで切替すると自動反映されます。': {
    en: 'Fixed 8 slots. DPI X/Y are independent; this tool writes X = Y (range 100–30000, steps of 50). Switching with the mouse DPI button is reflected automatically.',
    zh: '固定 8 个槽位。DPI X/Y 独立，但本工具以 X=Y 写入（范围 100–30000，步进 50）。使用鼠标 DPI 按键切换时会自动反映。',
  },
  '部分書き込みが他のバイトを保持することを実機確認済み。': {
    en: 'Verified on hardware that partial writes preserve the other bytes.',
    zh: '已在实机确认部分写入不会破坏其他字节。',
  },
  'センサー応答プリセット（公式Webドライバの Basic / Competitive / Max に対応）': {
    en: 'Sensor response preset (matches the official web driver: Basic / Competitive / Max).',
    zh: '传感器响应预设（对应官方 Web 驱动: Basic / Competitive / Max）。',
  },
  '0xA9ページへの書き込み後、0xB5確認ブロックも送信します（madr-libと同一手順）。': {
    en: 'After writing page 0xA9, a confirmation block is also sent to 0xB5 (same procedure as madr-lib).',
    zh: '写入 0xA9 页面后，还会向 0xB5 发送确认块（与 madr-lib 相同步骤）。',
  },
};

function trLabel(s) {
  if (typeof s !== 'string' || lang === 'ja') return s;
  const apply = (v) =>
    lang === 'en' ? v.replace('（最大 ', ' (max ').replace(' Hz）', ' Hz)') : v;
  const hit = LABEL_I18N[s];
  if (hit && hit[lang]) return apply(hit[lang]);
  // connection labels are built as "label（最大 N Hz）" — translate the prefix
  for (const [ja, tr] of Object.entries(LABEL_I18N)) {
    if (tr[lang] && s.startsWith(ja) && s.length > ja.length) {
      return apply(tr[lang] + s.slice(ja.length));
    }
  }
  return apply(s);
}

function applyStaticI18n() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.title = t('appTitle');
  const map = {
    brandSub: t('brandSub'),
    deviceInfoTitle: t('deviceInfo'),
    logTitle: t('log'),
    manageTitle: t('manageTitle'),
    manageHint: t('manageHint'),
    disclaimerNote: t('disclaimerShort'),
    langLabel: t('language'),
    buildInfoLabel: t('build'),
    manageBtnLabel: t('manage'),
    applyAllBtn: null, // text handled by updateApplyButton()
  };
  for (const [id, text] of Object.entries(map)) {
    if (text == null) continue;
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  const bat = $('#batteryChip');
  if (bat) bat.title = t('battery');
  const modeChip = $('#modeChip');
  if (modeChip) modeChip.title = t('applyModeTip');
  const applyBtn = $('#applyAllBtn');
  if (applyBtn) applyBtn.title = t('applyAllTip');
  const modeLabel = $('#applyModeLabel');
  const modeToggle = $('#applyModeToggle');
  if (modeLabel && modeToggle) modeLabel.textContent = modeToggle.checked ? t('applyImmediate') : t('applyManual');
  renderBuildInfo();
}

/* Build id (commit) shown in the header badge and the manage dialog. */
async function loadBuildInfo() {
  try {
    const r = await fetch('/api/build-info');
    const j = await r.json();
    buildInfo = (j && j.build) || null;
  } catch (e) {
    buildInfo = null;
  }
  renderBuildInfo();
}

function renderBuildInfo() {
  const badge = $('#buildBadge');
  const value = $('#buildInfoValue');
  if (!buildInfo || !buildInfo.label) {
    if (badge) badge.hidden = true;
    if (value) value.textContent = '—';
    return;
  }
  const built = buildInfo.builtAt ? new Date(buildInfo.builtAt) : null;
  const builtText =
    built && !Number.isNaN(built.getTime())
      ? built.toLocaleString(lang === 'en' ? 'en-US' : lang === 'zh' ? 'zh-CN' : 'ja-JP', {
          hour12: false,
        })
      : '';
  const details = [
    buildInfo.commit ? `commit ${buildInfo.commit}` : '',
    builtText ? `built ${builtText}` : '',
    buildInfo.electron ? `Electron ${buildInfo.electron}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (badge) {
    badge.hidden = false;
    badge.textContent = buildInfo.label;
    badge.title = details;
  }
  if (value) {
    value.textContent = buildInfo.label + (builtText ? `  (${builtText})` : '');
    value.title = details;
  }
}

function setLanguage(next) {
  if (!LANGS.includes(next)) return;
  lang = next;
  localStorage.setItem('uiLang', next);
  applyStaticI18n();
  builtFor = null;
  builtForDevice = null;
  render();
  const dlg = $('#manageDialog');
  if (dlg && dlg.open) renderManageList();
}

/* ------------------------------------------------------------------ utils */

function toast(text, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('fade'), 2200);
  setTimeout(() => el.remove(), 2600);
}

function addLog(text, isErr = false) {
  const li = document.createElement('li');
  if (isErr) li.className = 'err';
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  li.innerHTML = `<span class="t">${t}</span>`;
  li.appendChild(document.createTextNode(text));
  const list = $('#logList');
  list.prepend(li);
  list.scrollTop = 0; // keep the newest entry in view
  while (list.children.length > 40) list.lastChild.remove();
  const card = $('#logCard');
  if (card) {
    card.classList.add('flash');
    clearTimeout(addLog.flashTimer);
    addLog.flashTimer = setTimeout(() => card.classList.remove('flash'), 600);
  }
}

function rgbToHex(rgb) {
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function setBusy(v) {
  busy = v;
  $('#app').classList.toggle('busy', v);
}

function slot() {
  return slots[activeDevice] || {};
}

/* --------------------------------------------------------------- API glue */

async function applySetting(setting, args) {
  if (busy) return;
  setBusy(true);
  try {
    const r = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: activeDevice, setting, args }),
    });
    const j = await r.json();
    if (j.ok) {
      if (j.config) slot().config = j.config;
      if (j.devices) updateDevices(j.devices);
      render();
      toast(t('saved'));
      addLog(`✔ ${setting} ${JSON.stringify(args)}`);
    } else {
      toast(t('errorPrefix', j.error || r.status), 'error');
      addLog(`✖ ${setting}: ${j.error || 'failed'}`, true);
      refreshFromDevice();
    }
  } catch (e) {
    toast(t('commError', e.message), 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------ apply mode (immediate / manual) */

let applyModeImmediate = localStorage.getItem('applyMode') !== 'manual';
const pendingMap = new Map(); // signature -> { key, args, els }

function pendingSig(key, args) {
  return key + '|' + (args.op || '') + '|' + (args.index ?? '') + '|' + (args.field ?? '');
}

function clearPending() {
  pendingMap.clear();
  $$('.pending').forEach((el) => el.classList.remove('pending'));
  updateApplyButton();
}

function updateApplyButton() {
  const btn = $('#applyAllBtn');
  if (!btn) return;
  const n = pendingMap.size;
  btn.textContent = n ? t('applyWithCount', n) : t('apply');
  btn.classList.toggle('hidden', applyModeImmediate);
  btn.disabled = n === 0;
}

/**
 * Route a setting change: immediate mode POSTs right away; manual mode
 * records it as pending (the last value per setting wins) and waits for
 * the 適用 button.
 */
function commitSetting(key, args, els = []) {
  if (applyModeImmediate) {
    applySetting(key, args);
    return;
  }
  pendingMap.set(pendingSig(key, args), { key, args, els });
  for (const el of els) if (el && el.classList) el.classList.add('pending');
  updateApplyButton();
}

async function applyPending() {
  if (busy || !pendingMap.size) return;
  setBusy(true);
  let failed = 0;
  for (const [sig, e] of [...pendingMap]) {
    try {
      const r = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: activeDevice, setting: e.key, args: e.args }),
      });
      const j = await r.json();
      if (j.ok) {
        pendingMap.delete(sig);
        for (const el of e.els) if (el && el.classList) el.classList.remove('pending');
        if (j.config) slot().config = j.config;
        if (j.devices) updateDevices(j.devices);
        addLog(`✔ ${e.key} ${JSON.stringify(e.args)}`);
      } else {
        failed += 1;
        toast(t('errorPrefix', j.error || r.status), 'error');
        addLog(`✖ ${e.key}: ${j.error || 'failed'}`, true);
      }
    } catch (err) {
      failed += 1;
      toast(t('commError', err.message), 'error');
    }
  }
  setBusy(false);
  render();
  updateApplyButton();
  toast(failed ? t('applyFailedSome', failed) : t('applied'));
}

async function applyAction(action, args) {
  if (busy) return;
  setBusy(true);
  try {
    const r = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: activeDevice, action, args }),
    });
    const j = await r.json();
    if (j.ok) {
      const def = findAction(action);
      if (def && def.successMessage) toast(trLabel(def.successMessage), 'info');
      else toast(t('executed'), 'info');
      addLog(`⚙ ${t('actionRun', action)}`);
      if (j.devices) updateDevices(j.devices);
      refreshFromDevice();
    } else {
      toast(t('errorPrefix', j.error || r.status), 'error');
      addLog(`✖ ${action}: ${j.error || 'failed'}`, true);
    }
  } catch (e) {
    toast(t('commError', e.message), 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshFromDevice() {
  try {
    const r = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: activeDevice }),
    });
    const j = await r.json();
    if (j.ok) {
      clearPending(); // the device state wins over un-applied edits
      slot().config = j.config;
      if (j.devices) updateDevices(j.devices);
      render();
      return true;
    }
    toast(t('readFailed', j.error || r.status), 'error');
    return false;
  } catch (e) {
    toast(t('commError', e.message), 'error');
    return false;
  }
}

async function loadSchema(deviceId) {
  try {
    const r = await fetch(`/api/schema?device=${encodeURIComponent(deviceId)}`);
    const j = await r.json();
    if (j.ok && j.schema) {
      if (!slots[deviceId]) slots[deviceId] = {};
      slots[deviceId].schema = j.schema;
      if (deviceId === activeDevice) render();
    }
  } catch (e) {
    /* server unreachable — banner explains */
  }
}

async function loadConfig(deviceId) {
  try {
    const r = await fetch(`/api/config?device=${encodeURIComponent(deviceId)}`);
    if (r.ok) {
      const j = await r.json();
      if (j.ok) {
        if (!slots[deviceId]) slots[deviceId] = {};
        slots[deviceId].config = j.config;
        if (deviceId === activeDevice) render();
      }
    }
  } catch (e) {
    /* SSE will deliver config when ready */
  }
}

function findSetting(key) {
  const schema = slot().schema;
  if (!schema) return null;
  for (const sec of schema.ui.sections || []) {
    for (const s of sec.settings || []) if (s.key === key) return s;
  }
  return null;
}

function findAction(key) {
  const schema = slot().schema;
  if (!schema) return null;
  for (const sec of schema.ui.sections || []) {
    for (const a of sec.actions || []) if (a.key === key) return a;
  }
  return null;
}

/* ------------------------------------------------------------ DOM build */

function optionList(setting) {
  if (setting.options) {
    return setting.options.map((o) => ({ value: o.value, label: trLabel(o.label != null ? o.label : String(o.value)) }));
  }
  const codec = setting.read && setting.read.codec;
  if (codec && Array.isArray(codec.values)) {
    return codec.values.map((x) => ({ value: x.value, label: trLabel(x.label != null ? x.label : String(x.value)) }));
  }
  return [];
}

function buildToggleRow(label, id) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.style.minWidth = '180px';
  const t = document.createElement('label');
  t.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  const knob = document.createElement('span');
  knob.className = 'knob';
  const span = document.createElement('span');
  span.textContent = 'ON';
  t.append(input, knob, span);
  wrap.append(lab, t);
  return { wrap, input };
}

function hintEl(text, template = null, id = null) {
  const p = document.createElement('p');
  p.className = 'hint';
  if (id) p.id = id;
  if (template) {
    p.dataset.template = trLabel(template);
    p.textContent = trLabel(text) || '';
  } else {
    p.textContent = trLabel(text);
  }
  return p;
}

function parseOptionValue(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function buildUi() {
  const s = slot();
  if (!s.schema) return;
  builtFor = s.schema.id;
  // brand stays "sktdr-mouse"; the active model is shown in the device chips
  document.title = t('appTitle');
  const container = $('#sections');
  container.innerHTML = '';

  for (const sec of s.schema.ui.sections || []) {
    const card = document.createElement('section');
    card.className = 'card';
    card.dataset.section = sec.title;
    const h = document.createElement('h2');
    h.textContent = trLabel(sec.title);
    card.appendChild(h);

    for (const st of sec.settings || []) {
      card.appendChild(buildSetting(st));
    }

    for (const a of sec.actions || []) {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.style.minWidth = '180px';
      const btn = document.createElement('button');
      btn.className = 'btn' + (a.danger ? ' danger' : '');
      btn.id = `action-${a.key}`;
      btn.textContent = a.label;
      btn.addEventListener('click', () => runAction(a));
      row.append(lab, btn);
      card.appendChild(row);
    }

    container.appendChild(card);
  }
}

function buildSetting(s) {
  switch (s.type) {
    case 'segmented': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = trLabel(s.label || s.key);
      row.appendChild(lab);
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.id = `seg-${s.key}`;
      for (const o of optionList(s)) {
        const b = document.createElement('button');
        b.textContent = o.label.endsWith(s.unit || '') ? o.label : o.label + (s.unit || '');
        b.dataset.value = String(o.value);
        b.addEventListener('click', () => {
          if (!applyModeImmediate) {
            $$('button', seg).forEach((x) => x.classList.toggle('active', x === b));
          }
          commitSetting(s.key, { value: parseOptionValue(o.value) }, [seg]);
        });
        seg.appendChild(b);
      }
      row.appendChild(seg);
      if (s.hint) row.appendChild(hintEl(s.hint));
      if (s.hintFromMaxHz) row.appendChild(hintEl('', s.hintFromMaxHz, `hint-${s.key}-maxhz`));
      if (s.hintMouseMaxHz) row.appendChild(hintEl('', s.hintMouseMaxHz, `hint-${s.key}-mousemaxhz`));
      return row;
    }

    case 'select': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = trLabel(s.label || s.key);
      const sel = document.createElement('select');
      sel.id = `sel-${s.key}`;
      for (const o of optionList(s)) {
        const opt = document.createElement('option');
        opt.value = String(o.value);
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', (e) => {
        const def = optionList(s).find((o) => String(o.value) === e.target.value);
        commitSetting(s.key, { value: parseOptionValue(def ? def.value : e.target.value) }, [sel]);
      });
      row.append(lab, sel);
      return row;
    }

    case 'slider': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = `${trLabel(s.label || s.key)} `;
      const val = document.createElement('b');
      val.className = 'num';
      val.id = `val-${s.key}`;
      lab.appendChild(val);
      if (s.unit) lab.appendChild(document.createTextNode(s.unit));
      const number = document.createElement('input');
      number.type = 'number';
      number.id = `num-${s.key}`;
      number.min = s.min != null ? s.min : 0;
      number.max = s.max != null ? s.max : 100;
      number.step = s.step != null ? s.step : 1;
      const range = document.createElement('input');
      range.type = 'range';
      range.id = `range-${s.key}`;
      range.min = String(s.min != null ? s.min : 0);
      range.max = String(s.max != null ? s.max : 100);
      range.step = String(s.step != null ? s.step : 1);
      const clampCommit = (v) => {
        let n = Number(v);
        if (!Number.isFinite(n)) n = number.min != null ? Number(number.min) : 0;
        const lo = Number(range.min);
        const hi = Number(range.max);
        const st = Number(range.step) || 1;
        n = Math.min(hi, Math.max(lo, Math.round((n - lo) / st) * st + lo));
        number.value = String(n);
        range.value = String(n);
        const valEl = $(`#val-${s.key}`);
        if (valEl) valEl.textContent = String(n);
        commitSetting(s.key, { value: n }, [range, number]);
      };
      range.addEventListener('input', () => {
        number.value = range.value;
        const valEl = $(`#val-${s.key}`);
        if (valEl) valEl.textContent = range.value;
      });
      range.addEventListener('change', () => clampCommit(range.value));
      number.addEventListener('input', () => {
        const n = Number(number.value);
        if (Number.isFinite(n)) range.value = String(n);
      });
      number.addEventListener('change', () => clampCommit(number.value));
      row.append(lab, number, range);
      if (s.hint) row.appendChild(hintEl(s.hint));
      return row;
    }

    case 'toggle': {
      const { wrap, input } = buildToggleRow(trLabel(s.label || s.key), `tog-${s.key}`);
      input.addEventListener('change', (e) => {
        commitSetting(s.key, { value: e.target.checked }, [input]);
      });
      if (s.hint) wrap.appendChild(hintEl(s.hint));
      wrap.dataset.toggleKey = s.key;
      return wrap;
    }

    case 'color': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = trLabel(s.label || s.key);
      const c = document.createElement('input');
      c.type = 'color';
      c.id = `color-${s.key}`;
      c.addEventListener('change', (e) => {
        const rgb = hexToRgb(e.target.value);
        if (rgb) commitSetting(s.key, { value: rgb }, [c]);
      });
      row.append(lab, c);
      return row;
    }

    case 'dpiStages': {
      const wrap = document.createElement('div');
      wrap.dataset.dpiKey = s.key;

      if (s.countEditable !== false) {
        const row = document.createElement('div');
        row.className = 'row';
        const lab = document.createElement('label');
        lab.textContent = t('stageCount');
        const cnt = document.createElement('select');
        cnt.id = `dpi-count-${s.key}`;
        for (let i = 1; i <= num(s.maxRecords, 8); i++) {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = t('stagesOption', i);
          cnt.appendChild(o);
        }
        cnt.addEventListener('change', (e) => {
          commitSetting(s.key, { op: 'count', value: parseInt(e.target.value, 10) }, [cnt]);
        });
        const cur = document.createElement('span');
        cur.className = 'hint';
        cur.id = `dpi-current-${s.key}`;
        row.append(lab, cnt, cur);
        wrap.appendChild(row);
      } else {
        const row = document.createElement('div');
        row.className = 'row';
        const lab = document.createElement('label');
        lab.textContent = t('activeStage');
        const cur = document.createElement('span');
        cur.className = 'hint';
        cur.id = `dpi-current-${s.key}`;
        row.append(lab, cur);
        wrap.appendChild(row);
      }

      const stages = document.createElement('div');
      stages.className = 'dpi-stages';
      stages.id = `dpi-stages-${s.key}`;
      const vr = s.valueRange || { min: 50, max: 26000, step: 50 };
      for (let i = 0; i < num(s.maxRecords, 8); i++) {
        const r = document.createElement('div');
        r.className = 'dpi-row';
        r.dataset.index = String(i);

        const badge = document.createElement('span');
        badge.className = 'dpi-badge';
        badge.textContent = String(i + 1);

        const controls = document.createElement('div');
        controls.className = 'dpi-controls';
        const number = document.createElement('input');
        number.type = 'number';
        number.min = String(vr.min);
        number.max = String(vr.max);
        number.step = String(vr.step);
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(vr.min);
        range.max = String(vr.max);
        range.step = String(vr.step);
        controls.append(number, range);

        const color = document.createElement('input');
        color.type = 'color';
        color.title = t('stageColor');

        const use = document.createElement('button');
        use.className = 'btn small dpi-use';
        use.textContent = t('use');
        use.title = t('useTooltip');

        r.append(badge, controls, color, use);
        stages.appendChild(r);

        const commit = () => {
          let dpi = parseInt(number.value, 10);
          if (!Number.isFinite(dpi)) dpi = vr.min;
          dpi = Math.min(vr.max, Math.max(vr.min, Math.round(dpi / vr.step) * vr.step));
          number.value = String(dpi);
          range.value = String(dpi);
          commitSetting(s.key, { op: 'stageValue', index: i, value: dpi }, [number, range]);
        };
        number.addEventListener('change', commit);
        range.addEventListener('input', () => {
          number.value = range.value;
        });
        range.addEventListener('change', commit);
        color.addEventListener('change', (e) => {
          const rgb = hexToRgb(e.target.value);
          if (rgb) commitSetting(s.key, { op: 'stageColor', index: i, color: rgb }, [color]);
        });
        use.addEventListener('click', () => {
          if (!applyModeImmediate) {
            $$('.dpi-row', stages).forEach((x) => {
              x.classList.toggle('current', x === r);
              const b = $('button', x);
              if (b) b.textContent = x === r ? t('inUse') : t('use');
            });
            const curEl = $(`#dpi-current-${s.key}`);
            if (curEl) curEl.textContent = t('currentStage', i + 1);
          }
          commitSetting(s.key, { op: 'current', value: i }, [r]);
        });

        // profiles without per-stage colors hide the picker
        if (s.colors === false) color.style.display = 'none';
      }
      wrap.appendChild(stages);

      if (s.hint) wrap.appendChild(hintEl(s.hint));
      return wrap;
    }

    case 'group': {
      const wrap = document.createElement('div');
      wrap.dataset.groupKey = s.key;
      for (const f of s.fields || []) {
        if (f.type === 'select') {
          const row = document.createElement('div');
          row.className = 'row';
          const lab = document.createElement('label');
          lab.textContent = trLabel(f.label || f.key);
          const sel = document.createElement('select');
          sel.id = `grp-${s.key}-${f.key}`;
          const codecValues = (f.read && f.read.codec && f.read.codec.values) || [];
          for (const o of codecValues) {
            const opt = document.createElement('option');
            opt.value = String(o.value);
            opt.textContent = trLabel(o.label != null ? o.label : String(o.value));
            sel.appendChild(opt);
          }
          sel.addEventListener('change', (e) => {
            const hit = codecValues.find((o) => String(o.value) === e.target.value);
            commitSetting(s.key, { field: f.key, value: hit ? hit.value : e.target.value }, [sel]);
          });
          row.append(lab, sel);
          wrap.appendChild(row);
        } else if (f.type === 'color') {
          const row = document.createElement('div');
          row.className = 'row';
          const lab = document.createElement('label');
          lab.textContent = trLabel(f.label || f.key);
          const c = document.createElement('input');
          c.type = 'color';
          c.id = `grp-${s.key}-${f.key}`;
          c.addEventListener('change', (e) => {
            const rgb = hexToRgb(e.target.value);
            if (rgb) commitSetting(s.key, { field: f.key, value: rgb }, [c]);
          });
          row.append(lab, c);
          wrap.appendChild(row);
        } else if (f.type === 'slider') {
          const row = document.createElement('div');
          row.className = 'row';
          const lab = document.createElement('label');
          lab.textContent = `${trLabel(f.label || f.key)} `;
          const val = document.createElement('b');
          val.className = 'num';
          val.id = `grp-${s.key}-${f.key}-val`;
          lab.appendChild(val);
          const range = document.createElement('input');
          range.type = 'range';
          range.id = `grp-${s.key}-${f.key}`;
          range.min = f.min != null ? f.min : 0;
          range.max = f.max != null ? f.max : 100;
          range.step = f.step != null ? f.step : 1;
          range.addEventListener('input', () => {
            val.textContent = range.value;
          });
          range.addEventListener('change', () => {
            commitSetting(s.key, { field: f.key, value: Number(range.value) }, [range]);
          });
          row.append(lab, range);
          if (f.hint) row.appendChild(hintEl(f.hint));
          wrap.appendChild(row);
        }
      }
      if (s.on) {
        const { wrap: trow, input } = buildToggleRow(s.on.label || 'ON', `grp-${s.key}-${s.on.key || 'on'}`);
        input.addEventListener('change', (e) => {
          commitSetting(s.key, { field: s.on.key || 'on', value: e.target.checked }, [input]);
        });
        wrap.appendChild(trow);
      }
      return wrap;
    }

    default:
      return document.createComment(`unsupported setting type: ${s.type}`);
  }
}

function runAction(a) {
  const btn = $(`#action-${a.key}`);
  if (a.doubleClickConfirm) {
    if (a.key === 'factoryReset' && !resetArmed) {
      resetArmed = setTimeout(() => {
        btn.classList.remove('armed');
        btn.textContent = a.label;
        resetArmed = null;
      }, 4000);
      btn.classList.add('armed');
      btn.textContent = t('armedConfirm');
      return;
    }
    if (resetArmed) {
      clearTimeout(resetArmed);
      resetArmed = null;
      btn.classList.remove('armed');
      btn.textContent = a.label;
    }
    applyAction(a.key, { confirm: true });
    return;
  }
  if (a.confirm && !confirm(a.confirm)) return;
  applyAction(a.key, {});
}

/* ------------------------------------------------------------------ render */

function setChip(el, text, cls) {
  el.textContent = text;
  el.className = `chip ${cls}`;
}

/* ------------------------------------------------ connected-device chips */

const chipState = new Map(); // deviceId -> { seenAt, active }
const HIDE_AFTER_MS = 60 * 1000; // hide inactive (offline) chips after 1 minute

/** Which devices should currently show a header chip, and how. */
function visibleChips() {
  const now = Date.now();
  const out = [];
  for (const d of devicesStatus) {
    const isOnline = d.connected && d.online;
    let cs = chipState.get(d.id);
    if (!cs) {
      cs = { seenAt: isOnline ? now : 0 };
      chipState.set(d.id, cs);
    }
    if (isOnline) cs.seenAt = now; // last time we saw it alive/online
    const expired = !isOnline && now - cs.seenAt >= HIDE_AFTER_MS;
    if (cs.seenAt === 0) continue; // never connected: registered but not shown
    if (expired) continue; // offline for over a minute: hidden (listed in 管理)
    out.push({ device: d, isOnline, remaining: Math.max(1, Math.ceil((HIDE_AFTER_MS - (now - cs.seenAt)) / 1000)) });
  }
  // online chips first, then inactive ones
  out.sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
  return out;
}

function renderDeviceChips() {
  const holder = $('#deviceChips');
  holder.innerHTML = '';
  const chips = visibleChips();
  // Does the active device get a live chip of its own? If not (it's offline)
  // we render it separately as a gray, non-clickable chip so the header
  // always shows which device is being configured.
  if (activeDevice) {
    const live = chips.find((c) => c.device.id === activeDevice && c.isOnline);
    if (!live) {
      const d = devicesStatus.find((x) => x.id === activeDevice);
      if (d) {
        const chip = document.createElement('button');
        chip.className = 'chip device-chip chip-off';
        chip.disabled = true;
        chip.textContent = d.name + (d.connected && !d.online ? t('chipSleepSuffix') : '');
        chip.title = d.id;
        holder.appendChild(chip);
      }
    }
  }
  for (const { device: d, isOnline } of chips) {
    const chip = document.createElement('button');
    chip.className =
      'chip device-chip' +
      (isOnline ? (d.id === activeDevice ? ' active' : ' chip-ok') : ' chip-off');
    const dot = document.createElement('span');
    dot.className = 'dev-dot' + (isOnline ? ' on' : '');
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(d.name + (isOnline ? '' : t('chipOfflineSuffix'))));
    chip.title = d.id;
    chip.addEventListener('click', async () => {
      if (busy || d.id === activeDevice) return;
      clearPending(); // pending changes belong to the previous device
      activeDevice = d.id;
      render();
      await loadSchema(d.id);
      await loadConfig(d.id);
    });
    holder.appendChild(chip);
  }
}

function renderStatus() {
  const s = slot();
  const conn = $('#connChip');
  const bat = $('#batteryChip');
  const app = $('#app');
  const banner = $('#banner');

  renderDeviceChips();

  if (!devicesStatus.length || !activeDevice) {
    setChip(conn, t('notConnected'), 'chip-off');
    app.classList.add('disabled');
    banner.classList.remove('hidden', 'info');
    banner.textContent = t('noDevices');
    return;
  }

  const st = s.status || {};
  if (!st.connected) {
    setChip(conn, t('notConnected'), 'chip-off');
    app.classList.add('disabled');
    banner.classList.remove('hidden', 'info');
    banner.textContent = t('deviceNotConnected', s.schema ? s.schema.meta.name : activeDevice);
    return;
  }

  if (!st.online) {
    setChip(conn, t('sleeping'), 'chip-warn');
    app.classList.add('disabled');
    banner.classList.remove('hidden', 'info');
    banner.textContent =
      t('offlineBanner');
  } else {
    setChip(conn, trLabel(st.connection) || t('connected'), 'chip-ok');
    app.classList.remove('disabled');
    banner.classList.add('hidden');
  }

  if (st.battery) {
    const b = st.battery;
    const cls = b.level >= 60 ? 'chip-ok' : b.level >= 20 ? 'chip-warn' : 'chip-bad';
    setChip(bat, `${b.charging ? '⚡' : '🔋'} ${b.level}%`, cls);
    bat.title = b.voltage ? `${(b.voltage / 1000).toFixed(2)} V` : '';
  } else {
    setChip(bat, '🔋 --%', 'chip-off');
  }

  // device info card (schema-driven)
  const kv = $('#deviceKv');
  kv.innerHTML = '';
  for (const info of (s.schema && s.schema.ui.deviceInfo) || []) {
    const div = document.createElement('div');
    div.className = 'kv';
    const lab = document.createElement('label');
    lab.textContent = trLabel(info.label);
    const b = document.createElement('b');
    b.textContent = st[info.key] != null ? trLabel(String(st[info.key])) : '--';
    div.append(lab, b);
    kv.appendChild(div);
  }

  // per-device read/resync button (schema-driven, capability-honest)
  const actions = $('#deviceActions');
  if (actions) {
    actions.innerHTML = '';
    const rb = s.schema && s.schema.ui && s.schema.ui.readButton;
    if (rb) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.id = 'readDeviceBtn';
      btn.textContent = trLabel(rb.label) || t('readDevice');
      btn.disabled = !(st.connected && st.online) || busy;
      btn.addEventListener('click', async () => {
        const ok = await refreshFromDevice();
        if (ok) toast(trLabel(rb.successMessage) || t('readDone'));
      });
      actions.appendChild(btn);
      if (rb.note) actions.appendChild(hintEl(rb.note));
    }
  }

  const src = $('#protocolSource');
  if (src) {
    src.textContent =
      s.schema && s.schema.documentation && s.schema.documentation.protocolSource
        ? `${t('protocolSource')} ${s.schema.documentation.protocolSource}`
        : '';
  }
}

function renderConfig() {
  const s = slot();
  if (!s.config || !s.schema) return;
  const config = s.config;
  const online = s.status ? s.status.online : false;

  for (const sec of s.schema.ui.sections || []) {
    for (const st of sec.settings || []) renderSetting(st, config, online);
  }
}

function renderSetting(s, config, online) {
  switch (s.type) {
    case 'segmented': {
      const seg = $(`#seg-${s.key}`);
      if (!seg) return;
      const segPending = seg.classList.contains('pending');
      const st = slot().status || {};
      const connMax = st.maxHz != null ? Number(st.maxHz) : null;
      const bodyMax = st.mouseMaxHz != null ? Number(st.mouseMaxHz) : null;
      $$('button', seg).forEach((b) => {
        const v = Number(b.dataset.value);
        if (!segPending) {
          b.classList.toggle('active', config[s.key] != null && v === Number(config[s.key]));
        }
        // Rates above the current dongle's capability stay selectable (the
        // device stores them; they take effect with a capable dongle) but
        // are visually marked. Rates above the body capability are disabled.
        const overDongle = connMax != null && v > connMax;
        const overBody = bodyMax != null && v > bodyMax;
        b.classList.toggle('seg-over-max', overDongle && !overBody);
        b.disabled = !online || overBody;
        if (overDongle && !overBody) {
          b.title = t('overDongleTip');
        } else {
          b.removeAttribute('title');
        }
      });
      const hintElm = $(`#hint-${s.key}-maxhz`);
      if (hintElm && s.hintFromMaxHz && hintElm.dataset.template) {
        hintElm.textContent = hintElm.dataset.template.replace('{maxHz}', st.maxHz != null ? String(st.maxHz) : '?');
      }
      const mouseHint = $(`#hint-${s.key}-mousemaxhz`);
      if (mouseHint && s.hintMouseMaxHz && mouseHint.dataset.template) {
        const mismatch = bodyMax != null && connMax != null && bodyMax > connMax;
        mouseHint.style.display = mismatch ? '' : 'none';
        if (mismatch) {
          mouseHint.textContent = mouseHint.dataset.template
            .replace('{mouseMaxHz}', String(bodyMax))
            .replace('{maxHz}', String(connMax));
        }
      }
      break;
    }

    case 'select': {
      const sel = $(`#sel-${s.key}`);
      if (!sel) return;
      if (!sel.classList.contains('pending') && document.activeElement !== sel && config[s.key] != null) {
        sel.value = String(config[s.key]);
      }
      sel.disabled = !online;
      break;
    }

    case 'slider': {
      const range = $(`#range-${s.key}`);
      if (!range) return;
      const number = $(`#num-${s.key}`);
      const pend = range.classList.contains('pending');
      if (!pend && document.activeElement !== range && document.activeElement !== number) {
        const v = config[s.key] != null ? config[s.key] : '';
        range.value = String(v);
        if (number) number.value = String(v);
        const val = $(`#val-${s.key}`);
        if (val) val.textContent = config[s.key] != null ? config[s.key] : '--';
      }
      range.disabled = !online;
      if (number) number.disabled = !online;
      break;
    }

    case 'toggle': {
      const input = $(`#tog-${s.key}`);
      if (!input) return;
      if (!input.classList.contains('pending') && document.activeElement !== input) {
        input.checked = !!config[s.key];
      }
      input.disabled = !online;
      break;
    }

    case 'color': {
      const c = $(`#color-${s.key}`);
      if (!c) return;
      if (!c.classList.contains('pending') && document.activeElement !== c && config[s.key]) {
        c.value = rgbToHex(config[s.key]);
      }
      c.disabled = !online;
      break;
    }

    case 'dpiStages': {
      const d = config[s.key] || { count: 0, current: 0, records: [] };
      const cnt = $(`#dpi-count-${s.key}`);
      const cntPending = cnt && cnt.classList.contains('pending');
      if (cnt) {
        if (!cntPending && document.activeElement !== cnt) cnt.value = String(d.count || 1);
        cnt.disabled = !online || s.countEditable === false;
      }
      const stages = $(`#dpi-stages-${s.key}`);
      if (stages) {
        const curPend = $$('.dpi-row.pending', stages).some((x) => true);
        const cur = $(`#dpi-current-${s.key}`);
        if (cur && !curPend) cur.textContent = d.current != null ? t('currentStage', d.current + 1) : '';
      }
      if (!stages) return;
      $$('.dpi-row', stages).forEach((row) => {
        const i = Number(row.dataset.index);
        const rec = (d.records || [])[i];
        if (!rec) return;
        const rowPending = row.classList.contains('pending');
        const disabledByCount = i >= (d.count || 0);
        if (!rowPending) {
          row.classList.toggle('disabled', disabledByCount);
          row.classList.toggle('current', i === d.current);
        }
        const number = $('input[type="number"]', row);
        const range = $('input[type="range"]', row);
        const color = $('input[type="color"]', row);
        const use = $('button', row);
        if (use) use.textContent = i === d.current ? t('inUse') : t('use');
        if (!rowPending) {
          if (document.activeElement !== number && String(rec.value) !== number.value) {
            number.value = String(rec.value);
          }
          if (document.activeElement !== range) range.value = String(rec.value);
          if (color && document.activeElement !== color && rec.color) color.value = rgbToHex(rec.color);
        }
        number.disabled = range.disabled = use.disabled = disabledByCount || !online;
        if (color) color.disabled = disabledByCount || !online || s.colors === false;
      });
      break;
    }

    case 'group': {
      const g = config[s.key] || {};
      for (const f of s.fields || []) {
        const key = f.key;
        const el = $(`#grp-${s.key}-${key}`);
        const pend = el && el.classList.contains('pending');
        if (f.type === 'select') {
          const sel = el;
          if (sel && !pend && document.activeElement !== sel && g[key] != null) sel.value = String(g[key]);
          if (sel) sel.disabled = !online;
        } else if (f.type === 'color') {
          const c = el;
          if (c && !pend && document.activeElement !== c && g[key]) c.value = rgbToHex(g[key]);
          if (c) c.disabled = !online;
        } else if (f.type === 'slider') {
          const r = el;
          const val = $(`#grp-${s.key}-${key}-val`);
          if (r && !pend && document.activeElement !== r && g[key] != null) {
            r.value = String(g[key]);
            if (val) val.textContent = g[key];
          }
          if (r) r.disabled = !online;
        }
      }
      if (s.on) {
        const onKey = s.on.key || 'on';
        const input = $(`#grp-${s.key}-${onKey}`);
        if (input) {
          if (!input.classList.contains('pending') && document.activeElement !== input) {
            input.checked = !!g[onKey];
          }
          input.disabled = !online;
        }
      }
      break;
    }

    default:
      break;
  }
}

/** command-read settings may be unsupported (e.g. longRange) — hide them */
function renderCommandSettingVisibility() {
  const s = slot();
  if (!s.schema || !s.config) return;
  for (const sec of s.schema.ui.sections || []) {
    for (const st of sec.settings || []) {
      if (st.read && st.read.command && st.type === 'toggle') {
        const row = $(`#tog-${st.key}`);
        const wrap = row ? row.closest('.row') : null;
        if (wrap) wrap.style.display = s.config[st.key] == null ? 'none' : '';
      }
    }
  }
}

function render() {
  renderStatus();
  if (activeDevice && slot().schema) {
    if (builtFor !== slot().schema.id || activeDevice !== builtForDevice) {
      builtForDevice = activeDevice;
      buildUi();
    }
    renderConfig();
    renderCommandSettingVisibility();
  }
}
let builtForDevice = null;

function updateDevices(devices) {
  devicesStatus = devices || [];
  for (const d of devicesStatus) {
    if (!slots[d.id]) slots[d.id] = {};
    slots[d.id].status = { ...(slots[d.id].status || {}), ...d };
  }
  if (!activeDevice) {
    const first = devicesStatus.find((d) => d.connected) || devicesStatus[0];
    if (first) {
      activeDevice = first.id;
      loadSchema(first.id);
      loadConfig(first.id);
    }
  }
  render();
}

/* -------------------------------------------------------------------- SSE */

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    const { type, data } = msg;
    switch (type) {
      case 'status': {
        updateDevices(data);
        break;
      }
      case 'config': {
        const { device, data: cfg } = data;
        if (!slots[device]) slots[device] = {};
        slots[device].config = cfg;
        if (device === activeDevice) render();
        break;
      }
      case 'battery': {
        const { device, data: bat } = data;
        if (slots[device]) {
          slots[device].status = { ...(slots[device].status || {}), battery: bat };
          if (device === activeDevice) renderStatus();
        }
        break;
      }
      case 'online': {
        const { device, data: on } = data;
        if (slots[device]) {
          slots[device].status = { ...(slots[device].status || {}), online: !!on };
          render();
          if (!on && device === activeDevice) addLog(t('mouseOfflineLog'), true);
        }
        break;
      }
      case 'notification': {
        const { device } = data;
        addLog(t('notifChanged', device));
        break;
      }
      case 'waiting': {
        const device = data && data.device;
        if (device === activeDevice) {
          const st = slot().status || {};
          if (st.connected && !st.online) toast(t('moveMouse'), 'info');
        }
        break;
      }
      default:
        break;
    }
  };
}

/* -------------------------------------------------------------------- init */

/* ------------------------------------------------ manage dialog */

async function selectDeviceFromManage(deviceId) {
  const dlg = $('#manageDialog');
  if (dlg && dlg.open) dlg.close();
  if (busy || deviceId === activeDevice) return;
  clearPending();
  activeDevice = deviceId;
  render();
  await loadSchema(deviceId);
  await loadConfig(deviceId);
}

function statusLineFor(d) {
  if (d.connected && d.online) {
    const parts = [t('manageConnected')];
    if (d.battery && d.battery.level != null) parts.push(t('manageBattery', d.battery.level));
    return { text: parts.join(' / '), cls: 'manage-live' };
  }
  if (d.connected) {
    return { text: t('sleeping'), cls: 'manage-sleep' };
  }
  const cs = chipState.get(d.id);
  const seenBefore = cs && cs.seenAt > 0;
  return { text: seenBefore ? t('manageNotSeen') : t('notConnected'), cls: '' };
}

function renderManageList() {
  const container = $('#manageList');
  if (!container) return;
  container.innerHTML = '';
  for (const d of devicesStatus) {
    const row = document.createElement('div');
    row.className =
      'manage-row' +
      (d.id === activeDevice && d.connected && d.online ? ' active' : '') +
      (d.connected && d.online ? '' : ' inactive');
    const name = document.createElement('span');
    name.className = 'manage-name';
    name.textContent = d.name;
    name.title = d.id;
    const st = document.createElement('span');
    const stInfo = statusLineFor(d);
    st.className = 'manage-status ' + stInfo.cls;
    st.textContent = stInfo.text;
    row.append(name, st);
    if (d.connected && d.id !== activeDevice) {
      const btn = document.createElement('button');
      btn.className = 'btn small manage-use';
      btn.textContent = t('select');
      btn.addEventListener('click', () => selectDeviceFromManage(d.id));
      row.appendChild(btn);
    } else if (d.id === activeDevice) {
      const badge = document.createElement('span');
      badge.className = 'manage-status';
      badge.textContent = t('shown');
      row.appendChild(badge);
    }
    container.appendChild(row);
  }
  const note = document.createElement('p');
  note.className = 'empty-note';
  note.textContent = t('supportedMice', devicesStatus.map((x) => x.name).join(', ') || '-');
  container.appendChild(note);
}

function initManageDialog() {
  const dlg = $('#manageDialog');
  if (!dlg) return;
  const langSelect = $('#langSelect');
  if (langSelect) {
    langSelect.innerHTML = '';
    for (const l of LANGS) {
      const opt = document.createElement('option');
      opt.value = l;
      opt.textContent = LANG_NAMES[l];
      langSelect.appendChild(opt);
    }
    langSelect.value = lang;
    langSelect.addEventListener('change', (e) => setLanguage(e.target.value));
  }
  $('#manageBtn').addEventListener('click', () => {
    renderManageList();
    dlg.showModal();
  });
  $('#manageClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) {
      const rect = dlg.getBoundingClientRect();
      const outside = ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom;
      if (outside) dlg.close();
    }
  });
}

async function init() {
  applyStaticI18n();
  render();
  // apply-mode toggle (即時適用 / 保存ボタン) — persisted in localStorage
  const modeToggle = $('#applyModeToggle');
  const modeLabel = $('#applyModeLabel');
  const applyBtn = $('#applyAllBtn');
  if (modeToggle) {
    modeToggle.checked = applyModeImmediate;
    const syncModeUi = () => {
      if (modeLabel) modeLabel.textContent = modeToggle.checked ? t('applyImmediate') : t('applyManual');
    };
    syncModeUi();
    modeToggle.addEventListener('change', () => {
      applyModeImmediate = modeToggle.checked;
      localStorage.setItem('applyMode', applyModeImmediate ? 'immediate' : 'manual');
      syncModeUi();
      if (applyModeImmediate && pendingMap.size) applyPending(); // flush leftovers
      updateApplyButton();
    });
  }
  if (applyBtn) applyBtn.addEventListener('click', applyPending);
  updateApplyButton();
  initManageDialog();
  // chips gray out after 1 minute offline: refresh their state periodically
  setInterval(() => {
    renderDeviceChips();
    const dlg = $('#manageDialog');
    if (dlg && dlg.open) renderManageList();
  }, 5000);
  try {
    await loadBuildInfo();
    const r = await fetch('/api/status');
    const j = await r.json();
    updateDevices(j.devices || []);
  } catch (e) {
    toast(t('serverDown'), 'error');
  }
  connectEvents();
}

document.addEventListener('DOMContentLoaded', init);
