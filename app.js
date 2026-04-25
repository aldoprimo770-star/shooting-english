/**
 * 英単語スペースシューティング — シンプルな1ページ構成
 *
 * 語彙: 主に `words.json`（HTTP サーバーで開いたとき）を取得。
 * `file://` で直開きすると JSON の fetch は失われるため、同梱の `words-embed.js`（`node scripts/sync-words-embed.cjs` で words.json から再生成）をフォールバックとして読む。
 * ユーザー: LocalStorage / 発音: Web Speech API
 */

const STORAGE_KEY = "englishShootingUserData";
const SPEECH_LOCALE = "en-US";
const FEEDBACK_MS = 480; // 撃破後、正誤の色表示時間
/**
 * ミス制限: 0 = 制限なし。5 など正の数にすると、画面外落下＋誤答の累計でゲームオーバー
 * （完成条件の「10問以上プレイ」は、通常は MAX_MISTAKES=0 で満たす想定）
 */
const MAX_MISTAKES = 0;

/** @typedef {{ word: string, meaning: string, example: string, level: number, meaning_kana?: string }} Word */

/** 語彙データ。ゲーム中は **読み取り専用**（push/splice 等で書き換え禁止） */
/** @type {Word[]} */
let words = [];

/** @type {{ learnedWords: string[], mistakeWords: string[], score: number, cumulativeCorrect: number }} */
let userData = {
  learnedWords: [],
  mistakeWords: [],
  score: 0,
  /** シューティングで正解（正しい意味を撃破）した累積回数。進捗表示の主指標。 */
  cumulativeCorrect: 0,
};

let learnIndex = 0;
/** 学習画面の出題順。`goLearn` のたびに `words` からシャッフルし、毎回先頭20語に固定されないようにする */
let learnDeck = /** @type {Word[]} */ ([]);

/** セッション内の記録（リザルト用） */
let sessionHits = 0;
let sessionMistakeWords = [];

/** ゲーム用 */
let canvas;
let ctx;
let gameLoopId = null;
let gameActive = false;
/** スマホ用 touch リスナーは canvas に1回だけ */
let gameTouchControlsBound = false;
/** 指を動かしたスワイプ。true のあいだは「タップ発射」しない */
let isDragging = false;
/** タップ終了（スワイプでない）のとき1フレ（クールダウン後）で発射 */
let pendingTouchFire = false;
/** 画面回転・リサイズ用（デバウンス） */
let gameCanvasResizeTimer = 0;
let shipX = 0;
let keys = { left: false, right: false, fire: false };
let fireCooldown = 0;
let parallaxY = 0;
/** 撃墜後の正誤表示中は操作・落下を止める */
/**
 * @typedef {{
 *  cx: number, cy: number, r: number, meaning: string, isCorrect: boolean,
 *  word: string, vy: number, hue: number
 * }} Target
 */
/** @type {{ target: Target, ok: boolean, t0: number } | null} */
let feedbackState = null;
/** @type {Target[]} */
let targets = [];
let currentWordForSpeech = "";
/** @type {{ x: number, y: number, vy: number }[]} */
let bullets = [];
let currentQuestionWord = null;
/** 出題中の通し番号（1問目で1）。リザルト分母用 ※ 出題元は常に QuizEngine のみ */
let questionCount = 0;
/** このプレイ中の「ミス」合計（誤射＋正解未撃墜＝正解の落下） */
let missCountThisGame = 0;
/** デスクトップ等でベース解像度が必要なときの参照（スマホは主に `canvas.width/height`） */
const DEFAULT_CANVAS_W = 640;
const DEFAULT_CANVAS_H = 480;

function getCanvasW() {
  return canvas && canvas.width > 0 ? canvas.width : DEFAULT_CANVAS_W;
}
function getCanvasH() {
  return canvas && canvas.height > 0 ? canvas.height : DEFAULT_CANVAS_H;
}

/**
 * バッファ解像度（`canvas.width/height`）。極端に横長は負荷と横伸びを抑える
 */
function getGameCanvasPixelSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    w: Math.max(320, Math.min(Math.floor(w), 2000)),
    h: Math.max(200, Math.floor(h * 0.7)),
  };
}

/**
 * `canvas` の width/height を更新。プレイ中にサイズが変わるときは弾・敵・自機Xをスケール
 */
function applyGameCanvasDimensions() {
  const el = document.getElementById("game-canvas");
  if (!el) return;
  const { w: newW, h: newH } = getGameCanvasPixelSize();
  const ow = el.width;
  const oh = el.height;
  if (
    gameActive &&
    ow > 0 &&
    oh > 0 &&
    (newW !== ow || newH !== oh)
  ) {
    const sx = newW / ow;
    const sy = newH / oh;
    shipX *= sx;
    bullets.forEach((b) => {
      b.x *= sx;
      b.y *= sy;
    });
    targets.forEach((t) => {
      t.cx *= sx;
      t.cy *= sy;
      t.r = Math.max(12, t.r * (sx + sy) * 0.5);
    });
  }
  el.width = newW;
  el.height = newH;
}

/**
 * シューティング画面表示中のリサイズ・回転
 */
function onWindowResizeGameCanvas() {
  if (!document.getElementById("screen-game")?.classList.contains("active")) {
    return;
  }
  applyGameCanvasDimensions();
  if (canvas) {
    ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  }
}

/**
 * nextQuestion 実行中〜解放までの出題遷移ロック。同一フレ内の再入を抑止。
 * 解放は次のマクロタスク（setTimeout(0)）。仕様 300ms は初手弾のヒット喪失につながるため 0 を採用。
 * @type {boolean}
 */
let isTransitioning = false;
let transitionUnlockTimer = 0;

/** 学習用：一度に 20 語。全語彙を 20 語ずつ区切る（例: 120 語＝6 ブロック） */
const LEARN_BLOCK_SIZE = 20;
/** シューティング：1 回の出題数（学習ブロック 20 語のうち 10 語をランダム） */
const SHOOT_QUESTIONS = 10;
/**
 * 1プレイの出題数。HUD の分母（hud-question-max）と揃える。
 * @type {number}
 */
const maxQuestions = SHOOT_QUESTIONS;

/**
 * Fisher–Yates シャッフル。プレイごとの出題順はここ＋ init の完全依存（sort(乱数) は使わない）
 * @template T
 * @param {T[]} array
 * @returns {T[]}
 */
function shuffleArray(array) {
  let result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

/**
 * 毎回シャッフルし、可能なら **前プレイの出題語**（sessionStorage）を避けて多様性を上げる。
 * 語彙数が出題数未満のときは重なり不可避
 */
const LAST_PLAY_WORD_KEYS = "engShootLastPlayWordKeys";
const QuizEngine = {
  list: /** @type {Word[]} */ ([]),
  index: 0,

  /**
   * @param {Word[]} wordList
   */
  init(wordList) {
    console.log("🔥 初期化");
    if (!wordList.length) {
      this.list = [];
      this.index = 0;
      return;
    }
    let lastKeys = /** @type {string[]} */ ([]);
    try {
      const r = sessionStorage.getItem(LAST_PLAY_WORD_KEYS);
      if (r) lastKeys = JSON.parse(r);
    } catch (_) {}
    const lastSet = new Set(
      Array.isArray(lastKeys) ? lastKeys.map((k) => String(k)) : []
    );
    const notInLast = wordList.filter((w) => !lastSet.has(w.word));
    const need = Math.min(maxQuestions, wordList.length);
    /** @type {Word[]} */
    const pick = [];
    const used = new Set();
    if (notInLast.length >= need) {
      for (const w of shuffleArray([...notInLast])) {
        if (pick.length >= need) break;
        pick.push(w);
        used.add(w.word);
      }
    } else {
      for (const w of shuffleArray([...notInLast])) {
        if (pick.length >= need) break;
        if (!used.has(w.word)) {
          pick.push(w);
          used.add(w.word);
        }
      }
      for (const w of shuffleArray([...wordList])) {
        if (pick.length >= need) break;
        if (!used.has(w.word)) {
          pick.push(w);
          used.add(w.word);
        }
      }
    }
    this.list = pick;
    this.index = 0;
    try {
      sessionStorage.setItem(
        LAST_PLAY_WORD_KEYS,
        JSON.stringify(this.list.map((w) => w.word))
      );
    } catch (_) {}
    console.log("出題リスト:", this.list.map((w) => w.word));
  },

  next() {
    console.log("👉 index:", this.index);
    if (this.index >= this.list.length) return null;
    return this.list[this.index++];
  },
};

// --- Web Speech: 同時に鳴らさない（既存を止めてから1件だけ） ---
function stopEnglishSpeech() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

/**
 * 英語で読み上げ（en-US）
 * @param {string} text
 */
function speakEnglish(text) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (!String(text).trim()) return;
  stopEnglishSpeech();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = SPEECH_LOCALE;
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}

const GAME_SPEECH_MUTE_KEY = "englishShootingGameSpeechMuted";
let gameSpeechMuted = false;

function loadGameSpeechMute() {
  try {
    const v = localStorage.getItem(GAME_SPEECH_MUTE_KEY);
    gameSpeechMuted = v === "1" || v === "true";
  } catch (_) {
    gameSpeechMuted = false;
  }
  updateGameMuteButton();
}

function saveGameSpeechMute() {
  try {
    localStorage.setItem(GAME_SPEECH_MUTE_KEY, gameSpeechMuted ? "1" : "0");
  } catch (_) {}
}

function updateGameMuteButton() {
  const btn = document.getElementById("btn-game-mute");
  if (!btn) return;
  if (gameSpeechMuted) {
    btn.textContent = "音を出す";
    btn.setAttribute("aria-pressed", "true");
    btn.title = "出題の英語の読み上げをオンにする";
  } else {
    btn.textContent = "音を消す";
    btn.setAttribute("aria-pressed", "false");
    btn.title = "出題の英語の読み上げをオフにする";
  }
}

function setGameSpeechMuted(muted) {
  gameSpeechMuted = !!muted;
  saveGameSpeechMute();
  if (gameSpeechMuted) {
    stopEnglishSpeech();
  }
  updateGameMuteButton();
}

/**
 * シューティング画面専用：消音中は何も鳴らさない（学習・復習は従来どおり）
 * @param {string} text
 */
function speakGameEnglish(text) {
  if (gameSpeechMuted) return;
  speakEnglish(text);
}

// --- DOM ---
const screens = {
  home: document.getElementById("screen-home"),
  learn: document.getElementById("screen-learn"),
  game: document.getElementById("screen-game"),
  result: document.getElementById("screen-result"),
  review: document.getElementById("screen-review"),
};

function showScreen(name) {
  Object.keys(screens).forEach((k) => {
    screens[k].classList.toggle("active", k === name);
  });
}

function loadUserData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      userData = {
        learnedWords: Array.isArray(parsed.learnedWords) ? parsed.learnedWords : [],
        mistakeWords: Array.isArray(parsed.mistakeWords) ? parsed.mistakeWords : [],
        score: typeof parsed.score === "number" ? parsed.score : 0,
        cumulativeCorrect:
          typeof parsed.cumulativeCorrect === "number" && parsed.cumulativeCorrect >= 0
            ? Math.floor(parsed.cumulativeCorrect)
            : 0,
      };
    }
  } catch (e) {
    console.warn("LocalStorage の読み込みに失敗しました", e);
  }
}

/** 現在の words.json に存在する語だけ残し、重複を除く（進捗 100% 表示の不整合を防ぐ） */
function alignLearnedWordsToVocab() {
  if (!words.length) return;
  const keySet = new Set(words.map((w) => w.word));
  const before = userData.learnedWords.length;
  userData.learnedWords = [
    ...new Set(userData.learnedWords.filter((k) => keySet.has(k))),
  ];
  if (userData.learnedWords.length !== before) {
    saveUserData();
  }
}

function saveUserData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
  } catch (e) {
    console.warn("LocalStorage の保存に失敗しました", e);
  }
}

function updateProgressUI() {
  const total = words.length || 1;
  const c =
    typeof userData.cumulativeCorrect === "number" && userData.cumulativeCorrect >= 0
      ? userData.cumulativeCorrect
      : 0;
  // 全語彙数に対し「同じ本数の正解で 100%」、それ以上の正解でもバーは 100% まで
  const pct = Math.min(100, Math.round((c / total) * 100));
  const elBar = document.getElementById("progress-fill");
  const elText = document.getElementById("progress-text");
  if (elBar) elBar.style.width = `${pct}%`;
  if (elText) {
    elText.textContent = `正解累計 ${c} 回 ・ 目安 ${pct}% ／ 語彙 ${total} 語`;
  }
}

function wordByKey(w) {
  return words.find((x) => x.word === w) || null;
}

const VOCAB_ROUNDS_KEY = "englishShootingVocabRounds";
/** 全語を重複なく使い切るための順序と、今何番目の 20 語ブロックか */
let vocabRounds = { shuffledOrder: /** @type {string[]} */ ([]), blockIndex: 0 };

function buildShuffledOrderKeys() {
  return shuffleArray(words.map((w) => w.word));
}

function saveVocabRounds() {
  try {
    localStorage.setItem(VOCAB_ROUNDS_KEY, JSON.stringify(vocabRounds));
  } catch (_) {}
}

function initVocabRounds() {
  if (!words.length) {
    vocabRounds = { shuffledOrder: [], blockIndex: 0 };
    return;
  }
  const keySet = new Set(words.map((w) => w.word));
  try {
    const raw = localStorage.getItem(VOCAB_ROUNDS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (
        p &&
        Array.isArray(p.shuffledOrder) &&
        p.shuffledOrder.length === words.length &&
        p.shuffledOrder.every((k) => keySet.has(k)) &&
        new Set(p.shuffledOrder).size === words.length
      ) {
        vocabRounds = {
          shuffledOrder: p.shuffledOrder,
          blockIndex: Math.max(0, Math.floor(Number(p.blockIndex)) || 0),
        };
        return;
      }
    }
  } catch (_) {}
  vocabRounds = {
    shuffledOrder: buildShuffledOrderKeys(),
    blockIndex: 0,
  };
  saveVocabRounds();
}

function getBlockWordKeys() {
  const order = vocabRounds.shuffledOrder;
  const n = order.length;
  if (!n) return [];
  let start = vocabRounds.blockIndex * LEARN_BLOCK_SIZE;
  if (start >= n) {
    vocabRounds.blockIndex = 0;
    start = 0;
    saveVocabRounds();
  }
  return order.slice(start, start + LEARN_BLOCK_SIZE);
}

function getBlockWords() {
  return getBlockWordKeys()
    .map((k) => wordByKey(k))
    .filter(/** @returns {w is Word} */ (w) => w != null);
}

function advanceVocabBlock() {
  if (!words.length || !vocabRounds.shuffledOrder.length) return;
  const n = vocabRounds.shuffledOrder.length;
  vocabRounds.blockIndex += 1;
  if (vocabRounds.blockIndex * LEARN_BLOCK_SIZE >= n) {
    vocabRounds.shuffledOrder = buildShuffledOrderKeys();
    vocabRounds.blockIndex = 0;
  }
  saveVocabRounds();
}

function addMistakeWord(wordKey) {
  if (!userData.mistakeWords.includes(wordKey)) {
    userData.mistakeWords.push(wordKey);
  }
  if (!sessionMistakeWords.includes(wordKey)) {
    sessionMistakeWords.push(wordKey);
  }
  saveUserData();
}

// --- 学習画面（発音は wireLearnSpeech で一括。表示は learnDeck[learnIndex]） ---
function updateLearnCard() {
  if (!words.length) return;
  if (!learnDeck.length) {
    const b = getBlockWords();
    learnDeck = b.length ? shuffleArray([...b]) : [];
  }
  if (!learnDeck.length) return;
  learnIndex = Math.max(0, Math.min(learnIndex, learnDeck.length - 1));
  const w = learnDeck[learnIndex];
  document.getElementById("learn-word").textContent = w.word;
  document.getElementById("learn-meaning").textContent = w.meaning;
  document.getElementById("learn-example").textContent = w.example;
  document.getElementById("learn-counter").textContent = `${learnIndex + 1} / ${learnDeck.length}`;
}

function goLearn() {
  if (!words.length) return;
  if (!vocabRounds.shuffledOrder.length) initVocabRounds();
  learnDeck = shuffleArray([...getBlockWords()]);
  learnIndex = 0;
  updateLearnCard();
  showScreen("learn");
}

function learnNext() {
  if (!learnDeck.length) return;
  learnIndex = (learnIndex + 1) % learnDeck.length;
  updateLearnCard();
}

/**
 * 進捗用：語を「習得済み」に（学習の「覚えた」・シューティング正解の共通）
 * @param {string} wordKey
 */
function recordLearnedWordKey(wordKey) {
  if (!wordKey) return;
  if (!userData.learnedWords.includes(wordKey)) {
    userData.learnedWords.push(wordKey);
    saveUserData();
  }
}

function learnMarked() {
  const w = learnDeck[learnIndex];
  if (w) {
    recordLearnedWordKey(w.word);
    saveUserData();
  }
  learnNext();
}

// --- シューティング（出題専用は QuizEngine。正解英単語は next() 以外で変更しない）---
/**
 * 正解 meaning ＋ words 全体から誤答3つ。meaning は重複なし。語彙不足時は重複除いたうえで補充
 * @param {Word} currentWord
 * @param {Word[]} wlist
 * @returns {string[]}
 */
function generateChoices(currentWord, wlist) {
  const choices = [String(currentWord.meaning)];
  let otherWords = wlist.filter((w) => w.meaning !== currentWord.meaning);
  // 誤答の「日本語の意味」が他行と重ならないよう、行はまず meaning 単位で1本に
  {
    const seenM = new Set();
    otherWords = otherWords.filter((w) => {
      if (seenM.has(w.meaning)) return false;
      seenM.add(w.meaning);
      return true;
    });
  }
  otherWords = shuffleArray([...otherWords]);
  for (let i = 0; i < 3; i += 1) {
    if (otherWords[i]) {
      const m = String(otherWords[i].meaning);
      if (!choices.includes(m)) choices.push(m);
    }
  }
  if (choices.length < 4) {
    const pool = shuffleArray(
      wlist.filter((w) => w && !choices.includes(String(w.meaning)))
    );
    for (const w of pool) {
      if (choices.length >= 4) break;
      if (!choices.includes(String(w.meaning))) {
        choices.push(String(w.meaning));
      }
    }
  }
  return shuffleArray(choices);
}

function pickRandomWords(count, excludeWord) {
  const pool = words.filter((w) => w.word !== excludeWord);
  return shuffleArray([...pool]).slice(0, count);
}

/**
 * 画面の出題英単語は常にここ経由（固定文字列や learn 用 id への誤参照を防ぐ）
 * @param {string} wordStr
 */
function applyGameHudQuestionWord(wordStr) {
  const el = document.getElementById("game-question-word");
  if (!el) return;
  const s = String(wordStr);
  el.textContent = s;
  el.setAttribute("data-question", s);
}

function wireGameWordSpeech(wordStr) {
  currentWordForSpeech = wordStr;
  applyGameHudQuestionWord(wordStr);
  const h2 = document.getElementById("game-question-word");
  const btn = document.getElementById("btn-speak-game");
  const onSpeak = () => speakGameEnglish(currentWordForSpeech);
  if (h2) {
    h2.onclick = onSpeak;
    h2.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSpeak();
      }
    };
  }
  if (btn) btn.onclick = onSpeak;
}

/**
 * 出題英単語の表示を currentQuestionWord から毎フレーム再描画（DOM 更新の取りこぼし対策）
 */
function drawGameQuestionWordCanvasOverlay() {
  if (!ctx || !currentQuestionWord) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const fontPx = Math.max(16, Math.floor(getCanvasW() / 22));
  ctx.font = `${fontPx}px "Segoe UI", Meiryo, sans-serif`;
  ctx.fillStyle = "rgba(210, 225, 255, 0.92)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("単語: " + currentQuestionWord.word, 10, 12);
  ctx.restore();
}

/** 上部 HUD: 問題 n / 本ゲーム出題数 ＋ スコア */
function updateGameHud() {
  const elMax = document.getElementById("hud-question-max");
  const elNow = document.getElementById("hud-question-now");
  const cap = QuizEngine.list.length;
  if (elMax) {
    elMax.textContent = String(cap);
  }
  if (elNow) {
    const n = Math.min(questionCount, cap);
    elNow.textContent = String(n);
  }
  const hScore = document.getElementById("hud-score");
  if (hScore) hScore.textContent = String(sessionHits);
  const missWrap = document.getElementById("hud-miss-wrap");
  const elMiss = document.getElementById("hud-miss-count");
  if (missWrap) {
    missWrap.hidden = MAX_MISTAKES <= 0;
  }
  if (elMiss && MAX_MISTAKES > 0) {
    elMiss.textContent = String(missCountThisGame);
  }
}

/**
 * 次の1問。正解出題は QuizEngine.next() の戻り値だけを currentQuestionWord に入れる（他箇所で上書きしない）
 * 【調査結果】currentQuestionWord の代入は本関数内のみ。nextQuestion 呼び出しは
 *   startGame(1) / onHit待ち完了後(1) / 正解惑星の落下(1) — 遷移は isTransitioning + 次タスクで解放
 */
function nextQuestion() {
  if (isTransitioning) {
    console.warn("nextQuestion 重複呼び出しを抑止（遷移ロック中）");
    return;
  }
  isTransitioning = true;
  if (transitionUnlockTimer) {
    clearTimeout(transitionUnlockTimer);
    transitionUnlockTimer = 0;
  }
  try {
    console.log("nextQuestion 実行");

    const nextWord = QuizEngine.next();

    if (!nextWord) {
      showResult();
      return;
    }

    currentQuestionWord = nextWord;
    questionCount += 1;
    const currentWord = nextWord;

    feedbackState = null;
    bullets = [];
    // 敵＝4択の意味ラベル（毎問まっさらに再生成。古い円の残り描画を防ぐ）
    targets = [];

    wireGameWordSpeech(currentWord.word);
    updateGameHud();
    // 出題中は発音ボタンを押しづらいため、毎問その場で英語を読み上げ
    setTimeout(() => {
      if (currentQuestionWord && currentQuestionWord.word === currentWord.word) {
        speakGameEnglish(currentWord.word);
      }
    }, 0);

    const choices = generateChoices(currentWord, words);
    console.log("問題:", currentWord.word);
    console.log("選択肢:", choices);

    const cols = 4;
    const cw = getCanvasW();
    const ch = getCanvasH();
    const slotW = cw / cols;
    const r = Math.max(22, Math.min(56, Math.floor(cw / 20)));
    const yBoost = 50 * (ch / DEFAULT_CANVAS_H);
    const yRand = 70 * (ch / DEFAULT_CANVAS_H);
    const correctM = String(currentWord.meaning);
    choices.forEach((m, i) => {
      const meaningStr = String(m);
      const isCorrect = meaningStr === correctM;
      const col = i % cols;
      const baseCx = slotW * col + slotW / 2;
      const hue = (Math.random() * 40 + (col * 23 + 180)) % 360;
      const vy = (0.3 + Math.random() * 0.22) * (ch / DEFAULT_CANVAS_H);
      targets.push({
        cx: baseCx,
        cy: -r - yBoost - Math.random() * yRand,
        r,
        meaning: meaningStr,
        isCorrect,
        word: currentWord.word,
        vy,
        hue,
      });
    });
  } finally {
    // 同じ呼び出しスタック上では true のまま。スタック明け後に解放し、同フレ内の偽同時多発を弾く
    transitionUnlockTimer = setTimeout(() => {
      isTransitioning = false;
      transitionUnlockTimer = 0;
    }, 0);
  }
}

function resetGameState() {
  isTransitioning = false;
  if (transitionUnlockTimer) {
    clearTimeout(transitionUnlockTimer);
    transitionUnlockTimer = 0;
  }
  sessionHits = 0;
  sessionMistakeWords = [];
  questionCount = 0;
  missCountThisGame = 0;
  bullets = [];
  targets = [];
  feedbackState = null;
  parallaxY = 0;
  shipX = getCanvasW() / 2;
  fireCooldown = 0;
  keys = { left: false, right: false, fire: false };
  isDragging = false;
  pendingTouchFire = false;
}

/**
 * 表示上のスケール（CSS）と内部解像度（`canvas.width`）の差を補正。
 * @param {number} clientX
 */
function setShipXFromClientX(clientX) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 1;
  const W = getCanvasW();
  const m = Math.max(20, W * 0.04);
  const x = ((clientX - rect.left) / w) * W;
  shipX = Math.max(m, Math.min(W - m, x));
}

// ===== スマホ: 指で自機Xを合わせ、タップで keys.fire（キーボードと併用）
function wireGameTouchControls() {
  if (gameTouchControlsBound) return;
  const el = document.getElementById("game-canvas");
  if (!el) return;
  gameTouchControlsBound = true;

  el.addEventListener(
    "touchstart",
    (e) => {
      if (!gameActive || feedbackState != null || isTransitioning) return;
      e.preventDefault();
      isDragging = false;
      pendingTouchFire = false;
      const t = e.touches[0];
      if (t) setShipXFromClientX(t.clientX);
    },
    { passive: false }
  );

  el.addEventListener(
    "touchmove",
    (e) => {
      if (!gameActive || feedbackState != null || isTransitioning) return;
      e.preventDefault();
      isDragging = true;
      const t = e.touches[0];
      if (t) setShipXFromClientX(t.clientX);
    },
    { passive: false }
  );

  el.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (gameActive && feedbackState == null && !isTransitioning && !isDragging) {
      pendingTouchFire = true;
    }
    isDragging = false;
  });
  el.addEventListener("touchcancel", () => {
    isDragging = true;
    pendingTouchFire = false;
  });
}

function startGame() {
  if (!words.length) return;
  // プレイ中の二重起動のみ弾く（endGame 後は gameActive=false なので毎回 init される）
  if (gameActive) {
    console.warn("startGame 重複起動を無視");
    return;
  }

  canvas = document.getElementById("game-canvas");
  applyGameCanvasDimensions();
  ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  wireGameTouchControls();
  const block = getBlockWords();
  if (block.length < SHOOT_QUESTIONS) {
    console.warn("現在の 20 語ブロックに単語が足りず、10 問出せません。");
    return;
  }
  const quizList = shuffleArray([...block]).slice(0, SHOOT_QUESTIONS);
  resetGameState();
  // QuizEngine.init はこの1箇所からのみ（nextQuestion / gameLoop 等では呼ばない）
  QuizEngine.init(quizList);
  document.getElementById("hud-score").textContent = "0";
  showScreen("game");
  gameActive = true;
  nextQuestion();
  if (gameLoopId) cancelAnimationFrame(gameLoopId);
  gameLoopId = requestAnimationFrame(gameLoop);
}

/**
 * @param {{ advanceVocabBlock?: boolean }} [opts]
 */
function endGame(opts) {
  const o = opts || {};
  isTransitioning = false;
  if (transitionUnlockTimer) {
    clearTimeout(transitionUnlockTimer);
    transitionUnlockTimer = 0;
  }
  gameActive = false;
  feedbackState = null;
  if (
    o.advanceVocabBlock &&
    QuizEngine.list.length > 0 &&
    questionCount > 0 &&
    questionCount === QuizEngine.list.length
  ) {
    advanceVocabBlock();
  }
  if (gameLoopId) {
    cancelAnimationFrame(gameLoopId);
    gameLoopId = null;
  }
  // 正答率: 今回プレイで解答が確定した数 questionCount を分母にする
  const acc =
    questionCount > 0 ? Math.round((sessionHits / questionCount) * 100) : 0;
  document.getElementById("result-score").textContent = String(sessionHits);
  document.getElementById("result-accuracy").textContent = `${acc}%`;

  const ul = document.getElementById("result-mistakes");
  ul.innerHTML = "";
  const uniqueWrong = [...new Set(sessionMistakeWords)];
  if (!uniqueWrong.length) {
    ul.innerHTML = "<li>なし</li>";
  } else {
    uniqueWrong.forEach((w) => {
      const li = document.createElement("li");
      const info = wordByKey(w);
      li.textContent = info ? `${w}（${info.meaning}）` : w;
      ul.appendChild(li);
    });
  }

  if (sessionHits > userData.score) {
    userData.score = sessionHits;
    saveUserData();
  }

  {
    const gq = document.getElementById("game-question-word");
    if (gq) {
      gq.textContent = "—";
      gq.removeAttribute("data-question");
    }
  }
  showScreen("result");
}

/** 出題打ち切り（仕様上の showResult）。リザルト画面表示は endGame 本体 */
function showResult() {
  endGame({ advanceVocabBlock: true });
}

/**
 * ヒット表示が終わったあと、スコア集計 → 次の出題 or リザルト
 * @param {Target} t
 */
function onHitTarget(t) {
  if (t.isCorrect) {
    sessionHits += 1;
    if (currentQuestionWord) {
      recordLearnedWordKey(currentQuestionWord.word);
    }
    userData.cumulativeCorrect = (userData.cumulativeCorrect || 0) + 1;
    saveUserData();
    updateProgressUI();
  } else {
    if (currentQuestionWord) {
      addMistakeWord(currentQuestionWord.word);
    }
    missCountThisGame += 1;
  }
  if (MAX_MISTAKES > 0 && missCountThisGame >= MAX_MISTAKES) {
    endGame();
    return;
  }
  nextQuestion();
}

/** 円と弾（点）の当たり */
function hitCircle(t, bx, by) {
  const pad = 6 * (getCanvasW() / DEFAULT_CANVAS_W);
  return Math.hypot(bx - t.cx, by - t.cy) < t.r + pad;
}

/**
 * パララックス用の流れる星
 */
function drawSpaceBackground() {
  const W = getCanvasW();
  const H = getCanvasH();
  ctx.fillStyle = "#030212";
  ctx.fillRect(0, 0, W, H);
  const t = parallaxY;
  for (let i = 0; i < 100; i++) {
    const sx = (i * 47 + 13) % (W + 1);
    const base = (i * 23) % (H + 1);
    const y = (base + t * (0.2 + (i % 3) * 0.2)) % (H + 1);
    const a = 0.25 + Math.sin(i * 0.7 + t * 0.05) * 0.35;
    const sz = 1 + (i % 3) * 0.5;
    ctx.fillStyle = `rgba(220, 235, 255, ${a})`;
    ctx.fillRect(sx, y, sz, sz);
  }
  parallaxY += 0.35;
}

/**
 * 惑星: 円。装飾の hue。撃った瞬間まで正誤は分からない
 * @param {Target} t
 */
function drawPlanet(t) {
  const inFb = feedbackState && feedbackState.target === t;
  const ok = inFb && feedbackState && feedbackState.ok;

  ctx.beginPath();
  ctx.arc(t.cx, t.cy, t.r, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${t.hue}, 48%, 40%)`;
  if (inFb) {
    ctx.fillStyle = ok
      ? "rgba(50, 200, 100, 0.55)"
      : "rgba(220, 60, 90, 0.5)";
  }
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = inFb
    ? (ok ? "#3dff7a" : "#ff4466")
    : "rgba(200, 220, 255, 0.45)";
  if (inFb) {
    ctx.lineWidth = 3;
  }
  ctx.stroke();

  if (inFb) {
    const ringR = t.r + (ok ? 8 : 10);
    const grad = ok ? "rgba(0, 255, 100, 0.35)" : "rgba(255, 0, 80, 0.35)";
    ctx.beginPath();
    ctx.arc(t.cx, t.cy, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  const band = 0.55;
  ctx.beginPath();
  ctx.ellipse(
    t.cx,
    t.cy,
    t.r * 0.92,
    t.r * band,
    0.3,
    0,
    Math.PI * 2
  );
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = inFb
    ? (ok ? "#0a0a0a" : "#1a0a0a")
    : "#0a0a1a";
  const fontPx = Math.max(12, Math.floor(getCanvasW() / 20));
  ctx.font = `${fontPx}px "Segoe UI", Meiryo, sans-serif`;
  ctx.textAlign = "center";
  const maxChars = fontPx > 20 ? 8 : 9;
  const lines =
    t.meaning.length > maxChars + 1
      ? [t.meaning.slice(0, maxChars), t.meaning.slice(maxChars)]
      : [t.meaning];
  const lineH = fontPx * 1.15;
  const mid = lines.length === 1 ? fontPx * 0.25 : 0;
  lines.forEach((line, j) => {
    ctx.fillText(line, t.cx, t.cy + j * lineH + mid);
  });
  ctx.textAlign = "left";
}

function drawBullet(b) {
  const br = 10 * (getCanvasW() / DEFAULT_CANVAS_W);
  const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, br);
  g.addColorStop(0, "rgba(255, 255, 200, 1)");
  g.addColorStop(0.45, "rgba(255, 200, 80, 0.4)");
  g.addColorStop(1, "rgba(255, 100, 40, 0)");
  ctx.beginPath();
  ctx.arc(b.x, b.y, br, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  const core = 2.5 * (getCanvasW() / DEFAULT_CANVAS_W);
  ctx.beginPath();
  ctx.arc(b.x, b.y, core, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffcc";
  ctx.fill();
}

/** ロケット風：胴体＋円錐＋尾翼＋噴射炎 */
function drawRocket(x, groundY) {
  const y = groundY;
  // 噴射炎
  const flicker = 0.85 + Math.random() * 0.2;
  ctx.beginPath();
  ctx.moveTo(x - 3, y + 2);
  ctx.lineTo(x, y + 4 + 18 * flicker);
  ctx.lineTo(x + 3, y + 2);
  ctx.fillStyle = "rgba(255, 140, 50, 0.95)";
  ctx.fill();
  // 胴
  const bodyGrad = ctx.createLinearGradient(x - 10, y, x + 10, y);
  bodyGrad.addColorStop(0, "#4a3a6a");
  bodyGrad.addColorStop(0.5, "#6a5a8a");
  bodyGrad.addColorStop(1, "#3a2a4a");
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(x - 8, y - 24, 16, 24);
  // 先端円錐
  ctx.beginPath();
  ctx.moveTo(x, y - 34);
  ctx.lineTo(x - 9, y - 22);
  ctx.lineTo(x + 9, y - 22);
  ctx.closePath();
  ctx.fillStyle = "#6c5a9c";
  ctx.fill();
  ctx.strokeStyle = "rgba(150, 220, 255, 0.6)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 窓
  ctx.beginPath();
  ctx.arc(x, y - 12, 4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(100, 220, 255, 0.35)";
  ctx.fill();
  // 尾翼
  ctx.fillStyle = "#4a2d5a";
  ctx.beginPath();
  ctx.moveTo(x - 8, y);
  ctx.lineTo(x - 20, y + 8);
  ctx.lineTo(x - 8, y + 4);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + 8, y);
  ctx.lineTo(x + 20, y + 8);
  ctx.lineTo(x + 8, y + 4);
  ctx.closePath();
  ctx.fill();
}

function gameLoop() {
  if (!gameActive) return;

  const W = getCanvasW();
  const H = getCanvasH();
  const m = Math.max(20, W * 0.04);
  const baseSpeed = 5.2 * (W / DEFAULT_CANVAS_W);
  const bottomPad = Math.max(40, Math.min(70, H * 0.1));
  const shipBottomY = H - bottomPad;
  const frozen = feedbackState != null;

  if (frozen) {
    if (performance.now() - feedbackState.t0 >= FEEDBACK_MS) {
      const t0 = feedbackState.target;
      feedbackState = null;
      onHitTarget(t0);
    }
  } else {
    if (keys.left) shipX -= baseSpeed;
    if (keys.right) shipX += baseSpeed;
    shipX = Math.max(m, Math.min(W - m, shipX));

    if (fireCooldown > 0) fireCooldown -= 1;
    if ((keys.fire || pendingTouchFire) && fireCooldown <= 0) {
      const bulletYOff = 32 * (H / DEFAULT_CANVAS_H);
      const bulletVy = -9.5 * (H / DEFAULT_CANVAS_H);
      bullets.push({ x: shipX, y: shipBottomY - bulletYOff, vy: bulletVy });
      fireCooldown = 12;
      if (pendingTouchFire) pendingTouchFire = false;
    }

    bullets.forEach((b) => {
      b.y += b.vy;
    });
    bullets = bullets.filter((b) => b.y > -20);

    targets.forEach((t) => {
      t.cy += t.vy * 2.1;
    });

    // 出題遷移中は弾-惑星の新規ヒットを扱わない（nextQuestion 二重化の芽を潰す）
    let hitThisFrame = false;
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
      if (isTransitioning) break;
      const b = bullets[bi];
      for (let ti = 0; ti < targets.length; ti++) {
        if (isTransitioning) break;
        const t = targets[ti];
        if (hitCircle(t, b.x, b.y)) {
          hitThisFrame = true;
          bullets = [];
          feedbackState = { target: t, ok: t.isCorrect, t0: performance.now() };
          break;
        }
      }
      if (hitThisFrame) break;
    }

    if (!hitThisFrame && !isTransitioning) {
      // 正解の惑星が画面下へ（＝未撃墜）→ ミスとして1問完結し、次へ（即ゲームオーバーはしない）
      const off = targets.find(
        (t) => t.isCorrect && t.cy - t.r > H + 4
      );
      if (off && currentQuestionWord) {
        addMistakeWord(currentQuestionWord.word);
        missCountThisGame += 1;
        if (MAX_MISTAKES > 0 && missCountThisGame >= MAX_MISTAKES) {
          endGame();
        } else {
          nextQuestion();
        }
      }
    }
  }

  // --- 描画：通常もフィードバック中も同じ（撃った1個だけ drawPlanet 内で緑/赤） ---
  drawSpaceBackground();
  targets.forEach((t) => drawPlanet(t));
  if (!frozen) {
    bullets.forEach(drawBullet);
  }

  drawRocket(shipX, shipBottomY);

  // キャンバス上の出題語は毎フレーム currentQuestionWord から（DOM 参照ミスと切り分け可能）
  drawGameQuestionWordCanvasOverlay();

  if (gameActive) {
    gameLoopId = requestAnimationFrame(gameLoop);
  }
}

function onKeyDown(e) {
  if (!screens.game.classList.contains("active")) return;
  if (feedbackState) return;
  if (e.code === "ArrowLeft") keys.left = true;
  if (e.code === "ArrowRight") keys.right = true;
  if (e.code === "Space") {
    e.preventDefault();
    keys.fire = true;
  }
}

function onKeyUp(e) {
  if (e.code === "ArrowLeft") keys.left = false;
  if (e.code === "ArrowRight") keys.right = false;
  if (e.code === "Space") keys.fire = false;
}

// --- 復習 ---
let reviewWordKey = null;

function showReviewEmpty(show) {
  document.getElementById("review-empty").classList.toggle("hidden", !show);
  document.getElementById("review-quiz").classList.toggle("hidden", show);
}

function setReviewSpeech(w) {
  const wEl = document.getElementById("review-word");
  const bEl = document.getElementById("btn-speak-review");
  const fn = () => speakEnglish(w.word);
  if (wEl) {
    wEl.onclick = fn;
    wEl.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    };
  }
  if (bEl) bEl.onclick = fn;
}

function nextReviewQuestion() {
  const list = userData.mistakeWords;
  if (!list.length) {
    showReviewEmpty(true);
    return;
  }
  showReviewEmpty(false);
  reviewWordKey = list[0];
  const w = wordByKey(reviewWordKey);
  if (!w) {
    userData.mistakeWords = list.filter((k) => k !== reviewWordKey);
    saveUserData();
    nextReviewQuestion();
    return;
  }
  const rw = document.getElementById("review-word");
  rw.textContent = w.word;
  setReviewSpeech(w);

  const wrongMeanings = pickRandomWords(3, w.word).map((x) => x.meaning);
  const choices = shuffleArray([w.meaning, ...wrongMeanings]);
  const container = document.getElementById("review-choices");
  container.innerHTML = "";
  choices.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = m;
    btn.addEventListener("click", () => {
      if (m === w.meaning) {
        userData.mistakeWords = userData.mistakeWords.filter(
          (k) => k !== reviewWordKey
        );
        saveUserData();
        updateProgressUI();
        nextReviewQuestion();
      } else {
        btn.style.borderColor = "var(--danger)";
      }
    });
    container.appendChild(btn);
  });
}

function openReview() {
  loadUserData();
  updateProgressUI();
  showScreen("review");
  nextReviewQuestion();
}

const FALLBACK_SAMPLE_WORDS = [
  { word: "apple", meaning: "りんご", example: "I eat an apple.", level: 1 },
  { word: "book", meaning: "本", example: "This is a book.", level: 1 },
  { word: "cat", meaning: "ねこ", example: "I have a cat.", level: 1 },
  { word: "dog", meaning: "いぬ", example: "The dog runs.", level: 1 },
  { word: "egg", meaning: "たまご", example: "I like eggs.", level: 1 },
  { word: "fish", meaning: "さかな", example: "Fish swim in water.", level: 1 },
  { word: "girl", meaning: "女の子", example: "The girl reads.", level: 1 },
  { word: "hand", meaning: "て", example: "Wash your hands.", level: 1 },
  { word: "ice", meaning: "こおり", example: "Ice is cold.", level: 1 },
  { word: "jump", meaning: "とぶ", example: "I can jump high.", level: 1 },
  { word: "king", meaning: "おうさま", example: "The king is kind.", level: 1 },
  { word: "lion", meaning: "ライオン", example: "A lion is strong.", level: 1 },
  { word: "moon", meaning: "つき", example: "The moon is bright.", level: 1 },
  { word: "nest", meaning: "す", example: "Birds make a nest.", level: 1 },
  { word: "orange", meaning: "オレンジ", example: "This is an orange.", level: 1 },
  { word: "pen", meaning: "ペン", example: "I write with a pen.", level: 1 },
  { word: "queen", meaning: "じょおう", example: "The queen smiles.", level: 1 },
  { word: "rain", meaning: "あめ", example: "Rain falls today.", level: 1 },
  { word: "sun", meaning: "たいよう", example: "The sun is hot.", level: 1 },
  { word: "tree", meaning: "き", example: "This is a big tree.", level: 1 },
];

/**
 * 1) fetch words.json（キャッシュ古い 20 語版を掴まない）
 * 2) 失敗時は `words-embed.js`（words.json 同期。file:// 用）
 * 3) 最後の手段のみ内蔵 20 語
 */
async function loadWords() {
  const parseJson = async (res) => {
    if (!res.ok) return null;
    try {
      const j = await res.json();
      return Array.isArray(j) && j.length > 0 ? j : null;
    } catch (_) {
      return null;
    }
  };

  try {
    const res = await fetch("words.json", { cache: "no-store" });
    const list = await parseJson(res);
    if (list) {
      words = list;
      return;
    }
  } catch (_) {
    /* ネットワーク/スキーム不許可等 */
  }

  const g =
    typeof globalThis !== "undefined" &&
    Array.isArray(globalThis.__ENG_SHOOTING_WORDS__) &&
    globalThis.__ENG_SHOOTING_WORDS__.length
      ? globalThis.__ENG_SHOOTING_WORDS__
      : null;
  if (g) {
    words = g;
    console.info(
      `words.json の fetch に失敗したため、埋め込み ${words.length} 語（words-embed.js）を使用しています。`
    );
    return;
  }

  words = FALLBACK_SAMPLE_WORDS;
  console.warn(
    "words.json も words-embed.js も使えないため、内蔵 20 語だけです。words-embed.js を同梱するか、HTTP サーバーで index を開いてください。"
  );
}

function initBackgroundStars() {
  const el = document.getElementById("stars");
  if (!el) return;
  for (let i = 0; i < 85; i++) {
    const s = document.createElement("div");
    s.className = "bg-star";
    if (Math.random() < 0.4) s.classList.add("sm");
    if (Math.random() < 0.15) s.classList.add("lg");
    s.style.left = `${Math.random() * 100}%`;
    s.style.top = `${Math.random() * 100}%`;
    s.style.animationDelay = `${Math.random() * 2.2}s`;
    s.style.setProperty("--tw", String(0.4 + Math.random() * 0.55));
    el.appendChild(s);
  }
}

/** 学習画面の発音：learnDeck[learnIndex]（同時再生は speakEnglish 内で防止） */
function wireLearnSpeech() {
  const card = document.querySelector(".learn-card");
  if (!card) return;
  card.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t) return;
    const w = learnDeck[learnIndex];
    if (!w) return;
    if (t.id === "btn-speak-word" || t.id === "learn-word") {
      speakEnglish(w.word);
    }
    if (t.id === "btn-speak-example" || t.id === "learn-example") {
      speakEnglish(w.example);
    }
  });
  const lw = document.getElementById("learn-word");
  if (lw) {
    lw.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const w = learnDeck[learnIndex];
        if (w) speakEnglish(w.word);
      }
    });
  }
}

function wireEvents() {
  initBackgroundStars();
  wireLearnSpeech();

  document.getElementById("btn-start").addEventListener("click", () => {
    loadUserData();
    updateProgressUI();
    goLearn();
  });
  document.getElementById("btn-review").addEventListener("click", openReview);
  document.getElementById("btn-learn-home").addEventListener("click", () => {
    updateProgressUI();
    showScreen("home");
  });
  document.getElementById("btn-review-home").addEventListener("click", () => {
    updateProgressUI();
    showScreen("home");
  });
  document.getElementById("btn-next").addEventListener("click", learnNext);
  document.getElementById("btn-learned").addEventListener("click", learnMarked);
  document.getElementById("btn-to-game").addEventListener("click", startGame);
  document.getElementById("btn-game-mute").addEventListener("click", () => {
    setGameSpeechMuted(!gameSpeechMuted);
  });
  document.getElementById("btn-game-home").addEventListener("click", () => {
    gameActive = false;
    stopEnglishSpeech();
    if (gameLoopId) cancelAnimationFrame(gameLoopId);
    gameLoopId = null;
    showScreen("home");
  });
  document.getElementById("btn-result-home").addEventListener("click", () => {
    gameActive = false;
    updateProgressUI();
    showScreen("home");
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  window.addEventListener("resize", () => {
    if (gameCanvasResizeTimer) {
      clearTimeout(gameCanvasResizeTimer);
    }
    gameCanvasResizeTimer = setTimeout(() => {
      gameCanvasResizeTimer = 0;
      onWindowResizeGameCanvas();
    }, 100);
  });
}

(async function init() {
  await loadWords();
  loadUserData();
  alignLearnedWordsToVocab();
  initVocabRounds();
  updateProgressUI();
  wireEvents();
  loadGameSpeechMute();
})();
