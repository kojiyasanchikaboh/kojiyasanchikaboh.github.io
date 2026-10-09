/**
 * 予約画面（お客様用）
 * 手順：1 商品 → 2 受取日 → 3 受取時間 → 4 お客様の情報 → 5 確認 → 完了（要件 No.36）
 * - 表示する文字は textContent で入れる（APIの値を HTML として扱わない）
 * - 開いたときに受付期間の全日の空き状況（GET calendar）をまとめて取り、
 *   商品の段の上限と、カレンダーで選べる日（カートの商品を全部用意できる日）を決める
 * - 最終の確認（在庫・週の上限・締切）は送信時にサーバー側でもう一度行う
 * - スマホの「戻る」：モーダルは閉じるだけ、手順は1つ前へ（ページから出てしまわないように履歴を積む）
 */
(() => {
  const 状態 = {
    設定: null, // GET config の結果
    暦: [], // GET calendar の結果：[{ 日付, 曜日, 商品, 区分の残り, 時間帯 }]（受付期間の受け付けられる日）
    暦の取得時刻: 0,
    日付: '', // 選んだ受取日 yyyy-MM-dd
    空き: null, // 選んだ日の空き状況（暦の1日分）
    時間帯: '', // 選んだ受取時間
    数量: {}, // カートの中身：商品ID → 個数
    表示中の月: '', // カレンダーの月 yyyy-MM
    分類: 'すべて', // 商品の段で選んでいる分類のタブ
    段: '', // 表示中の段
    送信ID: '', // 二重登録の防止。受け付けられるまで同じ番号で送り直す
    完了: false, // 受け付けられたら true（戻る操作で確認の段に戻らないように）
  };

  /** 空き状況をこの時間より前に取っていたら、受取日の段に進むときに取り直す */
  const 暦を取り直す間隔 = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);

  /** 要素を作る（属性と子。子は文字か要素） */
  function 作る(タグ, 属性, ...子) {
    const e = document.createElement(タグ);
    Object.entries(属性 || {}).forEach(([k, v]) => {
      if (v === false || v == null) return;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
    子.flat().forEach((c) => {
      if (c == null || c === false) return;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return e;
  }

  const 円 = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
  const 曜日 = ['日', '月', '火', '水', '木', '金', '土'];
  const 二桁 = (n) => String(n).padStart(2, '0');

  /** 'yyyy-MM-dd' → { 年, 月, 日, 曜日番号 }（暦として扱う。時刻は使わない） */
  function 日付を分ける(s) {
    const [y, m, d] = s.split('-').map(Number);
    return { 年: y, 月: m, 日: d, 曜日番号: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
  }
  const 日付の文字 = (s) => {
    const d = 日付を分ける(s);
    return `${d.月}月${d.日}日（${曜日[d.曜日番号]}）`;
  };

  // ───────────────────────────────────────────── 段の切り替えと履歴

  const 段の一覧 = ['読み込み', '読み込み失敗', 'メンテナンス中', '段1', '段2', '段3', '段4', '段5', '段6'];
  let 補足のタイマー = 0;

  function 段を出す(id) {
    段の一覧.forEach((s) => { $(s).hidden = s !== id; });
    // 読み込みが長引いたら（GAS の起動し直し）、閉じずに待ってもらう案内を出す
    clearTimeout(補足のタイマー);
    $('読み込みの補足').hidden = true;
    if (id === '読み込み') 補足のタイマー = setTimeout(() => { $('読み込みの補足').hidden = false; }, 8000);

    const 番号 = /^段(\d)$/.exec(id);
    $('進み具合').hidden = !番号 || id === '段6';
    if (番号) {
      状態.段 = id;
      document.querySelectorAll('#進み具合 li').forEach((li) => {
        const n = Number(li.dataset.step);
        li.classList.toggle('済', n < Number(番号[1]));
        li.classList.toggle('今', n === Number(番号[1]));
      });
    }
    // 2段目からは上のロゴを小さくして、画面を広く使う
    document.body.classList.toggle('ヘッダー小', !!番号 && id !== '段1');
    $('カートボタンの枠').hidden = id !== '段1';
    document.body.classList.toggle('カートあり', id === '段1');
    window.scrollTo(0, 0);
  }

  /** 段を描き直してから出す（戻ったときにも最新の状態で出す） */
  function 段を描いて出す(id) {
    if (id === '段1') 商品を描く();
    if (id === '段2') カレンダーを描く();
    if (id === '段3') 時間帯を描く();
    if (id === '段5') 確認を描く();
    段を出す(id);
  }

  /** 次の段へ（履歴を1つ積む） */
  function 進む(id) {
    段を描いて出す(id);
    history.pushState({ 段: id }, '');
  }

  /** 前の段へ（積んだ履歴を戻す。戻れないときはそのまま出す） */
  function 段まで戻る(id) {
    const 今 = Number(状態.段.slice(1));
    const 先 = Number(id.slice(1));
    if (history.state && history.state.段 === 状態.段 && 今 > 先) history.go(先 - 今);
    else 段を描いて出す(id);
  }

  window.addEventListener('popstate', (e) => {
    const s = e.state || {};
    // 受け付けた後は、戻る操作をしても完了の画面のまま（同じ予約をもう一度送らないように）
    if (状態.完了) {
      段を出す('段6');
      return;
    }
    if (開いているモーダル) {
      モーダルを隠す();
      const 後で = 閉じた後;
      閉じた後 = null;
      if (後で) 後で();
      return;
    }
    if (s.モーダル) { history.back(); return; } // 「進む」でモーダルの履歴に来たときは戻しておく
    if (s.段 && s.段 !== 状態.段 && 状態.設定) 段を描いて出す(s.段);
  });

  // ───────────────────────────────────────────── モーダル

  let 開いているモーダル = null;
  let 閉じた後 = null;
  let 前のスクロール = 0;

  function モーダルを開く(id) {
    if (開いているモーダル) モーダルを隠す();
    開いているモーダル = $(id);
    前のスクロール = window.scrollY;
    // 後ろの画面が一緒に動かないように固定する（iPhone 対策で position: fixed）
    document.body.style.top = `-${前のスクロール}px`;
    document.body.classList.add('モーダル中');
    開いているモーダル.hidden = false;
    const 中身 = 開いているモーダル.querySelector('.モーダル_中身');
    if (中身) 中身.scrollTop = 0;
    開いているモーダル.querySelector('.モーダル_閉じる').focus({ preventScroll: true });
    history.pushState({ 段: 状態.段, モーダル: id }, '');
  }

  /** 閉じる（履歴を1つ戻す → popstate で隠す）。後で：閉じたあとに行う処理 */
  function モーダルを閉じる(後で) {
    if (!開いているモーダル) { if (後で) 後で(); return; }
    閉じた後 = 後で || null;
    if (history.state && history.state.モーダル) history.back();
    else {
      モーダルを隠す();
      const f = 閉じた後;
      閉じた後 = null;
      if (f) f();
    }
  }

  function モーダルを隠す() {
    if (!開いているモーダル) return;
    開いているモーダル.hidden = true;
    開いているモーダル = null;
    document.body.classList.remove('モーダル中');
    document.body.style.top = '';
    window.scrollTo(0, 前のスクロール);
  }

  document.querySelectorAll('.モーダル [data-close]').forEach((b) => b.addEventListener('click', () => モーダルを閉じる()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && 開いているモーダル) モーダルを閉じる(); });

  // キャンセルポリシー・プライバシーポリシー（文面は index.html の template。要件 No.38）
  document.querySelectorAll('[data-文面]').forEach((b) => b.addEventListener('click', () => {
    const 文面 = $(`文面_${b.dataset.文面}`);
    $('文面モーダル_中身').replaceChildren(文面.content.cloneNode(true));
    モーダルを開く('モーダル_文面');
  }));

  // ───────────────────────────────────────────── 読み込み

  const 読み込めなかった文 = (err) => (err && err.文)
    || (err && err.種類 === '時間切れ'
      ? '時間がかかっています。電波の良いところで、もう一度お試しください。'
      : 'インターネットにつながっているかご確認のうえ、もう一度お試しください。');

  /** 受付期間の空き状況を取る（失敗したら投げる） */
  async function 暦を取る() {
    const 暦 = await API.暦を取る();
    if (!暦 || !暦.ok) throw Object.assign(new Error('応答'), { 文: 暦 && 暦.エラー });
    状態.暦 = 暦.日;
    状態.暦の取得時刻 = Date.now();
  }

  async function はじめる() {
    段を出す('読み込み');
    try {
      const [設定] = await Promise.all([API.設定を取る(), 暦を取る()]);
      if (!設定 || !設定.ok) throw Object.assign(new Error('応答'), { 文: 設定 && 設定.エラー });
      状態.設定 = 設定;
    } catch (err) {
      $('読み込み失敗の文').textContent = 読み込めなかった文(err);
      問い合わせを出す();
      段を出す('読み込み失敗');
      return;
    }
    お知らせを出す();
    問い合わせを出す();
    if (状態.設定.メンテナンス中) {
      // 受付を止める：商品を選ぶ画面は出さず、案内と問い合わせ先だけ
      $('メンテナンス中の文').textContent = 状態.設定.メンテナンス中の案内文
        || 'ただいまメンテナンス中のため、ご予約の受付を一時停止しております。恐れ入りますが、しばらくしてから改めてお試しください。';
      段を出す('メンテナンス中');
      return;
    }
    $('上限個数').textContent = String(状態.設定.一商品の上限個数);
    history.replaceState({ 段: '段1' }, '');
    段を描いて出す('段1');
  }

  function お知らせを出す() {
    const s = 状態.設定;
    const 枠 = $('お知らせ');
    // メンテナンス中の案内はメンテナンスの段に出すので、ここは臨時のお知らせだけ
    const 文 = s.お知らせ;
    枠.textContent = 文 || '';
    枠.hidden = !文;
  }

  function 問い合わせを出す() {
    const s = 状態.設定 || {};
    [['Instagramへ', s.InstagramのURL], ['LINEへ', s.公式LINEのURL]].forEach(([id, url]) => {
      const a = $(id);
      if (url && /^https:\/\//.test(url)) { a.href = url; a.hidden = false; } else { a.hidden = true; }
    });
    $('問い合わせ').hidden = false;
  }

  // ───────────────────────────────────────────── 上限の計算（受付期間の全日から）

  /** 商品ID → 商品（カードの中の情報） */
  function 商品の索引() {
    const m = new Map();
    状態.設定.商品.forEach((c) => c.商品.forEach((p) => m.set(p.商品ID, p)));
    return m;
  }

  /**
   * その日に、その商品をいくつまで用意できるか
   * ＝ min(サーバーの上限（在庫・週の上限・1商品の上限）, 同じ区分のほかの商品の個数を引いた週の残りで選べる数)
   * @param 数量 商品ID → 個数（ほかの商品の個数として使う）
   */
  function その日の上限(商品, 数量, 日) {
    const 上限 = 日.商品[商品.商品ID];
    if (!上限) return 0;
    let n = 上限.上限;
    const 残り = 日.区分の残り ? 日.区分の残り[商品.区分] : null;
    if (商品.区分 && 商品.換算 > 0 && 残り != null) {
      let ほか = 0;
      商品の索引().forEach((q, id) => {
        if (id !== 商品.商品ID && q.区分 === 商品.区分) ほか += (数量[id] || 0) * q.換算;
      });
      n = Math.min(n, Math.floor((残り - ほか) / 商品.換算 + 1e-9));
    }
    return Math.max(0, n);
  }

  /** カート（数量）の商品を全部、その日に用意できるか */
  function 入る日か(数量, 日) {
    let 入る = true;
    商品の索引().forEach((p, id) => {
      const n = 数量[id] || 0;
      if (n > 0 && n > その日の上限(p, 数量, 日)) 入る = false;
    });
    return 入る;
  }

  const 入る日の一覧 = (数量) => 状態.暦.filter((日) => 入る日か(数量, 日));

  /**
   * 商品の段で、その商品をいくつまで選べるか
   * ＝ ほかのカートの商品を用意できる日の中で、その商品をいちばん多く用意できる日の数
   * （こうしておけば、カートを用意できる日が必ず1日は残る）
   */
  function 選べる上限(商品, 数量) {
    const ほか = Object.assign({}, 数量, { [商品.商品ID]: 0 });
    let 最大 = 0;
    状態.暦.forEach((日) => {
      if (入る日か(ほか, 日)) 最大 = Math.max(最大, その日の上限(商品, 数量, 日));
    });
    return 最大;
  }

  /** 受付期間のどの日にも用意できない商品 */
  const 受付終了か = (p) => 状態.暦.every((日) => !日.商品[p.商品ID] || 日.商品[p.商品ID].受付終了);

  /** 空き状況を取り直したとき、上限を超えた個数を減らす（減らした商品があれば知らせる） */
  function 数量を上限に合わせる() {
    const 減らした = [];
    商品の索引().forEach((p, id) => {
      const n = 状態.数量[id] || 0;
      if (n === 0) return;
      const 上限 = 選べる上限(p, 状態.数量);
      if (n > 上限) {
        if (上限 === 0) delete 状態.数量[id]; else 状態.数量[id] = 上限;
        減らした.push(p.商品名);
      }
    });
    if (減らした.length) {
      alert(`ご予約の状況が変わったため、次の商品の個数を減らしました。\n${減らした.join('\n')}`);
    }
  }

  function 合計(数量) {
    let 点数 = 0;
    let 金額 = 0;
    商品の索引().forEach((p, id) => {
      const n = 数量[id] || 0;
      点数 += n;
      金額 += n * p.価格;
    });
    return { 点数, 金額 };
  }

  // ───────────────────────────────────────────── 1. 商品：一覧（分類タブと2列のカード）

  /** 分類：商品マスタの「分類」ごとにカードをまとめる（空欄ならキャパ区分、それもなければ「その他」） */
  function 分類の一覧() {
    const 一覧 = [];
    const 索引 = new Map();
    状態.設定.商品.forEach((c) => {
      const 名前 = c.分類 || (c.商品[0] && c.商品[0].区分) || 'その他';
      if (!索引.has(名前)) {
        索引.set(名前, { 名前, カード: [] });
        一覧.push(索引.get(名前));
      }
      索引.get(名前).カード.push(c);
    });
    return 一覧;
  }

  const すべて = 'すべて';

  /** 選んだ分類の商品だけを出す（「すべて」は分類ごとの見出しつきで全部） */
  function 商品を描く() {
    $('商品_選べる日なし').hidden = 状態.暦.length > 0;
    const 分類 = 分類の一覧();
    if (状態.分類 !== すべて && !分類.some((k) => k.名前 === 状態.分類)) 状態.分類 = すべて;

    $('分類').replaceChildren(...[すべて, ...分類.map((k) => k.名前)].map((名前) => 作る('button', {
      type: 'button', class: `分類_タブ${名前 === 状態.分類 ? ' 今' : ''}`, 'aria-pressed': 名前 === 状態.分類 ? 'true' : 'false',
      onclick: () => {
        状態.分類 = 名前;
        商品を描く();
        // タブが画面の上に貼りついているときは、一覧の先頭に戻す
        const 上 = $('分類').getBoundingClientRect().top + window.scrollY;
        if (window.scrollY > 上) window.scrollTo(0, 上);
      },
    }, 名前)));
    $('分類').hidden = 分類.length < 2;

    const 出す = 状態.分類 === すべて ? 分類 : 分類.filter((k) => k.名前 === 状態.分類);
    $('商品').replaceChildren(...出す.map((k) => 作る('section', { class: '分類の段' },
      状態.分類 === すべて && 分類.length > 1 ? 作る('h3', { class: '分類の見出し' }, k.名前) : null,
      作る('div', { class: '品の一覧' }, k.カード.map((c) => 商品カード(c))),
    )));
    カートボタンを描く();
  }

  function 商品カード(c) {
    const 個数 = c.商品.reduce((s, p) => s + (状態.数量[p.商品ID] || 0), 0);
    const 全部終了 = c.商品.every((p) => 受付終了か(p));
    const 最安 = Math.min(...c.商品.map((p) => p.価格));
    const 価格 = c.商品.length > 1 ? `${円(最安)}〜` : 円(最安);
    return 作る('button', {
      type: 'button', class: `品${全部終了 ? ' 品_終了' : ''}`,
      'aria-label': `${c.グループ}　${価格}${全部終了 ? '　受付終了' : ''}${個数 ? `　カートに${個数}点` : ''}`,
      onclick: () => 商品の画面を開く(c),
    },
    作る('span', { class: '品_写真枠' },
      c.画像URL
        ? 作る('img', { class: '品_写真', src: c.画像URL, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : 作る('img', { class: '品_写真 品_写真なし', src: 'images/logo.png', alt: '' }),
      全部終了 ? 作る('span', { class: '品_終了札' }, '受付終了') : null,
      個数 ? 作る('span', { class: '品_個数' }, String(個数)) : null),
    作る('span', { class: '品_名前' }, c.グループ),
    作る('span', { class: '品_価格' }, 価格));
  }

  // ───────────────────────────────────────────── 1. 商品：詳しい画面（モーダル）

  let 選び中 = null; // { カード, 数量, 前の個数 }：決定するまでカートには入れない

  function 商品の画面を開く(c) {
    const 数量 = {};
    c.商品.forEach((p) => { 数量[p.商品ID] = 状態.数量[p.商品ID] || 0; });
    選び中 = { カード: c, 数量, 前の個数: c.商品.reduce((s, p) => s + 数量[p.商品ID], 0) };
    商品の画面を描く();
    モーダルを開く('モーダル_商品');
  }

  function 商品の画面を描く() {
    const c = 選び中.カード;
    // ほかの商品はカートの個数、この商品は選び中の個数で計算する
    const 全体 = Object.assign({}, 状態.数量, 選び中.数量);
    const 行 = c.商品.map((p) => サイズの行(p, 全体, (差) => {
      const n = 選び中.数量[p.商品ID] || 0;
      選び中.数量[p.商品ID] = Math.max(0, Math.min(選べる上限(p, 全体), n + 差));
      商品の画面を描く();
    }));

    $('商品モーダル_中身').replaceChildren(
      c.画像URL ? 作る('img', { class: 'モ_写真', src: c.画像URL, alt: c.グループ, referrerpolicy: 'no-referrer' }) : null,
      作る('h2', { class: 'モーダル_見出し', id: '商品モーダル_名前' }, c.グループ),
      c.説明 ? 作る('p', { class: 'モ_説明' }, c.説明) : null,
      作る('h3', { class: 'モ_小見出し' }, c.商品.length > 1 ? 'サイズと個数をお選びください' : '個数をお選びください'),
      作る('ul', { class: 'サイズの一覧' }, 行),
    );

    let 点数 = 0;
    let 金額 = 0;
    c.商品.forEach((p) => { 点数 += 選び中.数量[p.商品ID] || 0; 金額 += (選び中.数量[p.商品ID] || 0) * p.価格; });
    const 決定 = $('商品モーダル_決定');
    const 文 = 選び中.前の個数 === 0 ? 'カートに入れる' : (点数 === 0 ? 'カートから外す' : 'この内容にする');
    決定.replaceChildren(作る('span', null, 円(金額)), 作る('span', null, 文));
    決定.disabled = 選び中.前の個数 === 0 && 点数 === 0;
  }

  /** サイズ1つ分の行（− 個数 ＋）。変える(差) で個数を変える */
  function サイズの行(p, 数量, 変える) {
    const n = 数量[p.商品ID] || 0;
    const 名前 = p.サイズ || p.商品名;
    if (受付終了か(p) && n === 0) {
      return 作る('li', { class: 'サイズ 終了' },
        作る('span', { class: 'サイズ_名前' }, 名前, 作る('span', { class: 'サイズ_価格' }, 円(p.価格))),
        作る('span', { class: '札 札_終了' }, '受付終了'));
    }
    const 上限 = 選べる上限(p, 数量);
    const 上限に達した = n >= 上限;
    return 作る('li', { class: 'サイズ' },
      作る('span', { class: 'サイズ_名前' }, 名前, 作る('span', { class: 'サイズ_価格' }, 円(p.価格))),
      数量の操作(p, n, 上限に達した, 変える),
      上限 === 0
        ? 作る('span', { class: 'サイズ_注意' }, 'カートの商品と合わせると、これ以上ご用意できません')
        : 上限に達した && 上限 < 状態.設定.一商品の上限個数
          ? 作る('span', { class: 'サイズ_注意' }, 'ご用意できる数の上限です')
          : null);
  }

  function 数量の操作(p, n, 上限に達した, 変える) {
    return 作る('span', { class: '数量' },
      作る('button', { type: 'button', class: '数量_ボタン', 'aria-label': `${p.商品名}を1つ減らす`, disabled: n === 0, onclick: () => 変える(-1) }, '−'),
      作る('span', { class: '数量_数', 'aria-live': 'polite' }, String(n)),
      作る('button', { type: 'button', class: '数量_ボタン', 'aria-label': `${p.商品名}を1つ増やす`, disabled: 上限に達した, onclick: () => 変える(1) }, '＋'));
  }

  $('商品モーダル_決定').addEventListener('click', () => {
    Object.entries(選び中.数量).forEach(([id, n]) => {
      if (n > 0) 状態.数量[id] = n; else delete 状態.数量[id];
    });
    モーダルを閉じる(() => 商品を描く());
  });

  // ───────────────────────────────────────────── 1. 商品：カート

  function カートボタンを描く() {
    const { 点数, 金額 } = 合計(状態.数量);
    $('カートボタン').classList.toggle('空', 点数 === 0);
    $('カートボタン_点数').hidden = 点数 === 0;
    $('カートボタン_点数').textContent = String(点数);
    $('カートボタン_文').textContent = 点数 === 0 ? '商品をお選びください' : 'カートを見る';
    $('カートボタン_金額').textContent = 点数 === 0 ? '' : 円(金額);
  }

  function カートを描く() {
    const 行 = [];
    状態.設定.商品.forEach((c) => c.商品.forEach((p) => {
      const n = 状態.数量[p.商品ID] || 0;
      if (!n) return;
      const 上限 = 選べる上限(p, 状態.数量);
      行.push(作る('li', { class: 'カートの行' },
        作る('p', { class: 'カートの行_名前' }, c.グループ, c.商品.length > 1 ? 作る('span', { class: 'カートの行_サイズ' }, p.サイズ) : null),
        作る('div', { class: 'カートの行_下' },
          作る('button', {
            type: 'button', class: '削除', 'aria-label': `${p.商品名}をカートから外す`,
            onclick: () => { delete 状態.数量[p.商品ID]; カートの変更後(); },
          }, '削除'),
          作る('span', { class: 'カートの行_小計' }, 円(p.価格 * n)),
          数量の操作(p, n, n >= 上限, (差) => {
            const 次 = Math.max(0, Math.min(上限, n + 差));
            if (次 === 0) delete 状態.数量[p.商品ID]; else 状態.数量[p.商品ID] = 次;
            カートの変更後();
          }))));
    }));
    $('カートモーダル_一覧').replaceChildren(行.length
      ? 作る('ul', { class: 'カートの一覧' }, 行)
      : 作る('p', { class: '空の案内' }, 'カートに商品がありません'));

    const { 点数, 金額 } = 合計(状態.数量);
    $('カートモーダル_点数').textContent = `${点数}点`;
    $('カートモーダル_金額').textContent = 円(金額);
    $('カートモーダル_次へ').disabled = 点数 === 0;
  }

  function カートの変更後() {
    カートを描く();
    商品を描く();
  }

  $('カートボタン').addEventListener('click', () => {
    if (合計(状態.数量).点数 === 0) {
      const 先 = $('分類').hidden ? $('商品') : $('分類');
      window.scrollTo({ top: 先.getBoundingClientRect().top + window.scrollY - 8, behavior: 'smooth' });
      return;
    }
    カートを描く();
    モーダルを開く('モーダル_カート');
  });
  $('カートモーダル_次へ').addEventListener('click', () => モーダルを閉じる(受取日へ進む));

  // ───────────────────────────────────────────── 2. 受取日（月のカレンダー）

  /** 空き状況が古ければ取り直してから、受取日の段へ */
  async function 受取日へ進む() {
    if (Date.now() - 状態.暦の取得時刻 > 暦を取り直す間隔) {
      段を出す('読み込み');
      try {
        await 暦を取る();
        数量を上限に合わせる();
      } catch (err) {
        alert(読み込めなかった文(err));
        段を描いて出す('段1');
        return;
      }
    }
    if (合計(状態.数量).点数 === 0) { 段を描いて出す('段1'); return; }
    進む('段2');
  }

  function カレンダーを描く() {
    const 入る = new Set(入る日の一覧(状態.数量).map((日) => 日.日付));
    const 営業 = new Set(状態.暦.map((日) => 日.日付));
    $('選べる日なし').hidden = 入る.size > 0 || 営業.size === 0;
    if (状態.日付 && !入る.has(状態.日付)) { 状態.日付 = ''; 状態.時間帯 = ''; }

    if (営業.size === 0) {
      $('カレンダー').replaceChildren(作る('p', { class: '空の案内' },
        'ただいまご予約いただける日がありません。', 作る('br'),
        'Instagram の DM または公式LINE からお問い合わせください。'));
      return;
    }
    const 月の一覧 = [...new Set([...営業].map((d) => d.slice(0, 7)))].sort();
    if (!月の一覧.includes(状態.表示中の月)) {
      const 最初 = 状態.日付 || [...入る].sort()[0] || [...営業].sort()[0];
      状態.表示中の月 = 最初.slice(0, 7);
    }
    const 位置 = 月の一覧.indexOf(状態.表示中の月);
    const [年, 月] = 状態.表示中の月.split('-').map(Number);

    const 前へ = 作る('button', {
      type: 'button', class: '月送り', 'aria-label': '前の月', disabled: 位置 <= 0,
      onclick: () => { 状態.表示中の月 = 月の一覧[位置 - 1]; カレンダーを描く(); },
    }, '‹');
    const 次へ = 作る('button', {
      type: 'button', class: '月送り', 'aria-label': '次の月', disabled: 位置 >= 月の一覧.length - 1,
      onclick: () => { 状態.表示中の月 = 月の一覧[位置 + 1]; カレンダーを描く(); },
    }, '›');

    const 表 = 作る('div', { class: '暦' });
    曜日.forEach((w, i) => 表.append(作る('div', { class: `暦_曜日 曜日${i}` }, w)));

    const 一日目の曜日 = new Date(Date.UTC(年, 月 - 1, 1)).getUTCDay();
    const 日数 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
    for (let i = 0; i < 一日目の曜日; i++) 表.append(作る('div', { class: '暦_空き' }));
    for (let d = 1; d <= 日数; d++) {
      const キー = `${年}-${二桁(月)}-${二桁(d)}`;
      const w = (一日目の曜日 + d - 1) % 7;
      if (入る.has(キー)) {
        表.append(作る('button', {
          type: 'button', class: `暦_日 選べる 曜日${w}${キー === 状態.日付 ? ' 選択中' : ''}`,
          'aria-label': `${日付の文字(キー)}を選ぶ`, 'aria-pressed': キー === 状態.日付 ? 'true' : 'false',
          onclick: () => 日付を選ぶ(キー),
        }, String(d)));
      } else {
        // 営業日だが、カートの商品を用意できない日は薄い印を付ける
        表.append(作る('div', { class: `暦_日 曜日${w}${営業.has(キー) ? ' 用意できない' : ''}`, 'aria-hidden': 'true' }, String(d)));
      }
    }

    $('カレンダー').replaceChildren(
      作る('div', { class: '暦_上' }, 前へ, 作る('p', { class: '暦_月' }, `${年}年${月}月`), 次へ),
      表,
    );
  }

  function 日付を選ぶ(日付) {
    const 日 = 状態.暦.find((x) => x.日付 === 日付);
    if (!日) return;
    状態.日付 = 日付;
    状態.空き = 日;
    if (!日.時間帯.some((t) => t.時間帯 === 状態.時間帯)) 状態.時間帯 = '';
    進む('段3');
  }

  // ───────────────────────────────────────────── 3. 受取時間

  function 時間帯を描く() {
    $('選んだ日_3').textContent = `受取日：${日付の文字(状態.日付)}`;
    const 一覧 = 状態.空き.時間帯.map((t) => 作る('button', {
      type: 'button',
      class: `時間帯_枠${t.混雑 ? ' 混雑' : ''}${t.時間帯 === 状態.時間帯 ? ' 選択中' : ''}`,
      'aria-pressed': t.時間帯 === 状態.時間帯 ? 'true' : 'false',
      onclick: () => {
        状態.時間帯 = t.時間帯;
        進む('段4');
      },
    }, 作る('span', { class: '時間帯_時刻' }, t.時間帯), t.混雑 ? 作る('span', { class: '札 札_混雑' }, '混雑') : null));
    $('時間帯').replaceChildren(...一覧);
  }

  // ───────────────────────────────────────────── 4. お客様の情報

  /** 入力欄（id の 入力_○○ と、サーバーが返す 項目 の名前を対応させる） */
  const 入力欄 = ['お名前', 'フリガナ', '電話番号', 'メールアドレス', 'メールアドレス確認'];
  const 欄 = (項目) => (項目 === 'お客様備考' ? $('入力_備考') : $(`入力_${項目}`));

  /** ひらがな → カタカナ（全角英数字なども標準の形に） */
  const カタカナに = (s) => s.normalize('NFKC').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const 電話番号の数字 = (s) => s.normalize('NFKC').replace(/[^0-9]/g, '');

  /** サーバー（共通_入力・共通_予約 の 予約の入力を確かめる_）と同じ決まりで確かめる。最初の誤りを返す */
  function 入力を確かめる() {
    const 値 = (id) => $(id).value.trim();
    const 名前 = 値('入力_お名前');
    if (!名前) return ['お名前', 'お名前を入力してください'];
    const フリガナ = 値('入力_フリガナ');
    if (!フリガナ) return ['フリガナ', 'フリガナを入力してください'];
    if (!/^[ァ-ヶー・\s]+$/.test(カタカナに(フリガナ))) return ['フリガナ', 'フリガナはカタカナで入力してください'];
    const 電話 = 電話番号の数字(値('入力_電話番号'));
    if (!電話) return ['電話番号', '電話番号を入力してください'];
    if (!/^0[0-9]{9,10}$/.test(電話)) return ['電話番号', '電話番号を正しく入力してください（例：090-1234-5678）'];
    const メール = 値('入力_メールアドレス');
    if (!メール) return ['メールアドレス', 'メールアドレスを入力してください'];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(メール)) return ['メールアドレス', 'メールアドレスを正しく入力してください（例：hanako@example.com）'];
    const 確認 = 値('入力_メールアドレス確認');
    if (!確認) return ['メールアドレス確認', '確認のため、メールアドレスをもう一度入力してください'];
    if (メール.toLowerCase() !== 確認.toLowerCase()) return ['メールアドレス確認', 'メールアドレスが一致しません。もう一度ご確認ください'];
    if ([...値('入力_備考')].length > 500) return ['お客様備考', '備考は500文字以内で入力してください'];
    return null;
  }

  function 入力のエラーを消す() {
    [...入力欄, 'お客様備考'].forEach((k) => {
      $(`エラー_${k}`).hidden = true;
      欄(k).removeAttribute('aria-invalid');
    });
  }

  /** 欄の下に理由を出し、その欄へ移動する */
  function 入力のエラーを出す(項目, 文) {
    const 枠 = $(`エラー_${項目}`);
    if (!枠) return false;
    枠.textContent = 文;
    枠.hidden = false;
    const 入力 = 欄(項目);
    入力.setAttribute('aria-invalid', 'true');
    入力.setAttribute('aria-describedby', 枠.id);
    入力.scrollIntoView({ block: 'center' });
    入力.focus({ preventScroll: true });
    return true;
  }

  $('入力_フリガナ').addEventListener('blur', (e) => { e.target.value = カタカナに(e.target.value); });
  // 全角で入力された数字・記号・英字を半角に直す（確認画面とメールで読みやすく）
  const 半角に = (e) => { e.target.value = e.target.value.normalize('NFKC').replace(/[‐－―−ー]/g, '-').trim(); };
  $('入力_電話番号').addEventListener('blur', 半角に);
  ['入力_メールアドレス', '入力_メールアドレス確認'].forEach((id) => $(id).addEventListener('blur', (e) => { e.target.value = e.target.value.normalize('NFKC').trim(); }));
  // 直し始めたら、その欄のエラーを消す
  [...入力欄, 'お客様備考'].forEach((k) => 欄(k).addEventListener('input', () => {
    $(`エラー_${k}`).hidden = true;
    欄(k).removeAttribute('aria-invalid');
  }));

  $('お客様の情報').addEventListener('submit', (e) => {
    e.preventDefault();
    入力のエラーを消す();
    $('入力_フリガナ').value = カタカナに($('入力_フリガナ').value);
    ['入力_電話番号', '入力_メールアドレス', '入力_メールアドレス確認'].forEach((id) => $(id).dispatchEvent(new Event('blur')));
    const 誤り = 入力を確かめる();
    if (誤り) { 入力のエラーを出す(誤り[0], 誤り[1]); return; }
    進む('段5');
  });

  // ───────────────────────────────────────────── 5. 確認

  function 確認を描く() {
    $('確認_受取').textContent = `${日付の文字(状態.日付)}　${状態.時間帯}`;
    const 冷蔵 = $('入力_冷蔵希望').checked;
    $('確認_お渡し').textContent = 冷蔵 ? 'お渡し：冷蔵（ご希望）' : 'お渡し：冷凍';
    $('確認_冷凍の説明').hidden = 冷蔵;

    const 行 = [];
    let 要冷蔵あり = false;
    状態.設定.商品.forEach((c) => c.商品.forEach((p) => {
      const n = 状態.数量[p.商品ID] || 0;
      if (!n) return;
      if (p.要冷蔵) 要冷蔵あり = true;
      行.push(作る('li', null,
        作る('span', { class: '確認_商品名' }, c.グループ, c.商品.length > 1 ? 作る('span', { class: 'カートの行_サイズ' }, p.サイズ) : null),
        作る('span', { class: '確認_数量' }, `${円(p.価格)} × ${n}`),
        作る('span', { class: '確認_小計' }, 円(p.価格 * n))));
    }));
    $('確認_商品').replaceChildren(...行);
    const { 点数, 金額 } = 合計(状態.数量);
    $('確認_点数').textContent = `${点数}点`;
    $('確認_金額').textContent = 円(金額);
    $('確認_保冷バッグ').hidden = !要冷蔵あり;

    const 備考 = $('入力_備考').value.trim();
    const 項目 = [
      ['お名前', $('入力_お名前').value.trim()],
      ['フリガナ', $('入力_フリガナ').value.trim()],
      ['電話番号', $('入力_電話番号').value.trim()],
      ['メールアドレス', $('入力_メールアドレス').value.trim()],
      ['備考', 備考 || 'なし'],
    ];
    $('確認_お客様').replaceChildren(...項目.flatMap(([k, v]) => [作る('dt', null, k), 作る('dd', null, v)]));
    $('エラー_同意').hidden = true;
    $('送信のエラー').hidden = true;
  }

  $('入力_同意').addEventListener('change', () => { $('エラー_同意').hidden = true; });

  // ───────────────────────────────────────────── 送信

  /** 送信ID：英数字とハイフン（サーバーの 送信IDの形か_ に合わせる） */
  function 送信IDを作る() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const 数 = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(数);
    return Array.from(数, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  let 送信中 = false;

  async function 送信する() {
    if (送信中) return;
    if (!$('入力_同意').checked) {
      $('エラー_同意').textContent = '内容をご確認のうえ、同意のチェックを入れてください';
      $('エラー_同意').hidden = false;
      $('入力_同意').focus();
      return;
    }
    if (!状態.送信ID) 状態.送信ID = 送信IDを作る();
    const 予約 = {
      送信ID: 状態.送信ID,
      お名前: $('入力_お名前').value.trim(),
      フリガナ: $('入力_フリガナ').value.trim(),
      電話番号: $('入力_電話番号').value.trim(),
      メールアドレス: $('入力_メールアドレス').value.trim(),
      メールアドレス確認: $('入力_メールアドレス確認').value.trim(),
      受取日: 状態.日付,
      受取時間帯: 状態.時間帯,
      冷蔵希望: $('入力_冷蔵希望').checked,
      お客様備考: $('入力_備考').value.trim(),
      同意: true,
      品目: Object.entries(状態.数量).filter(([, n]) => n > 0).map(([商品ID, 数量]) => ({ 商品ID, 数量 })),
      ホームページ: $('入力_ホームページ').value,
    };

    送信中 = true;
    $('送信').disabled = true;
    $('送信のエラー').hidden = true;
    $('送信中').hidden = false;
    let 結果;
    try {
      // 起動し直し（最大20秒あまり）＋混んでいるときの順番待ちがあるため、長めに待つ
      結果 = await API.送る({ action: 'reserve', 予約 }, 60);
    } catch (err) {
      送信を終える();
      送信のエラーを出す(err && err.種類 === '時間切れ'
        ? '時間がかかっているため、ご予約が届いたか確認できませんでした。お手数ですが、もう一度「この内容で予約する」を押してください（同じご予約が2件になることはありません）。受付メールが届いている場合は、ご予約は完了しています。'
        : '通信できませんでした。電波の良いところで、もう一度「この内容で予約する」を押してください（同じご予約が2件になることはありません）。');
      return;
    }
    送信を終える();

    if (結果 && 結果.ok) {
      完了を出す(結果);
      return;
    }
    送信できなかったとき(結果 || {});
  }

  function 送信を終える() {
    送信中 = false;
    $('送信').disabled = false;
    $('送信中').hidden = true;
  }

  function 送信のエラーを出す(文) {
    $('送信のエラー').textContent = 文;
    $('送信のエラー').hidden = false;
    $('送信のエラー').scrollIntoView({ block: 'center' });
  }

  /** サーバーが受け付けなかったとき：直す場所の段へ案内する */
  async function 送信できなかったとき(結果) {
    const 項目 = 結果.項目 || '';
    const 文 = 結果.エラー || 'ご予約を受け付けられませんでした。もう一度お試しください。';
    if (入力欄.includes(項目) || 項目 === 'お客様備考') {
      段まで戻る('段4');
      setTimeout(() => 入力のエラーを出す(項目, 文), 300);
      return;
    }
    if (項目 === '同意') {
      $('エラー_同意').textContent = 文;
      $('エラー_同意').hidden = false;
      return;
    }
    if (['受取日', '受取時間帯', '品目'].includes(項目)) {
      // 締切・在庫・週の上限が変わった：空き状況を取り直して、選び直してもらう
      alert(項目 === '品目' ? `${文}\n最新の受付状況で、商品を選び直してください。` : 文);
      try {
        await 暦を取る();
        数量を上限に合わせる();
      } catch (err) { /* 取り直せなくても、選び直しの段へ戻る */ }
      段まで戻る(項目 === '品目' ? '段1' : '段2');
      return;
    }
    送信のエラーを出す(文);
  }

  // ───────────────────────────────────────────── 6. 完了

  function 完了を出す(結果) {
    状態.完了 = true;
    $('完了_見出し').textContent = 結果.確定 ? 'ご予約が確定しました' : 'ご予約を受け付けました';
    $('完了_受付番号').textContent = 結果.受付番号;
    $('完了_照会へ').href = `shokai.html?no=${encodeURIComponent(結果.受付番号)}`;
    let 文;
    if (結果.確定) {
      文 = '確定のメールをお送りしました。ご来店をお待ちしております。';
    } else {
      文 = 'まだ確定ではありません。店舗で内容を確認し、2営業日以内に確定のメールをお送りします。確定のメールをもって、ご予約の完了となります。';
    }
    if (結果.メール送信 === false) {
      文 += '\n\nただいまメールをお送りできませんでした。ご予約は受け付けていますので、店舗からのご連絡をお待ちください。';
    }
    $('完了_文').textContent = 文;
    状態.数量 = {};
    状態.送信ID = '';
    history.replaceState({ 段: '段6' }, '');
    段を出す('段6');
  }

  $('送信').addEventListener('click', 送信する);
  $('もう一度予約').addEventListener('click', () => { location.href = location.pathname; });

  // ───────────────────────────────────────────── 操作

  document.querySelectorAll('.段 [data-back]').forEach((b) => {
    b.addEventListener('click', () => 段まで戻る(b.dataset.back));
  });
  $('再読み込み').addEventListener('click', はじめる);

  はじめる();
})();
