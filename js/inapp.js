/**
 * アプリ内ブラウザ（Instagram・Facebook・LINE）で開いたときの案内（CLAUDE.md 2-3。予約画面・予約照会で共通）
 * 10/03 の検証でアプリ内ブラウザでも動くことは確かめてあるため、操作は止めず、上に小さく出すだけ（×で閉じられる）
 * - LINE：URL に openExternalBrowser=1 を付けると、ふだんのブラウザで開き直せる
 * - Android の Instagram・Facebook：intent:// で Chrome を開く
 * - iPhone の Instagram・Facebook：「…」メニューから外部ブラウザで開く案内（ボタンでは開けない）
 */
(() => {
  const ua = navigator.userAgent;
  const アプリ = /Instagram/i.test(ua) ? 'Instagram'
    : /FBAN|FBAV|FB_IAB/i.test(ua) ? 'Facebook'
      : / Line\//i.test(ua) ? 'LINE' : '';
  if (!アプリ) return;

  const 閉じた印 = 'アプリ内ブラウザの案内を閉じた';
  try { if (sessionStorage.getItem(閉じた印)) return; } catch (e) { /* 保存できない環境でも案内は出す */ }

  const Android = /Android/i.test(ua);
  const 作る = (タグ, 属性, 文) => {
    const e = document.createElement(タグ);
    Object.entries(属性 || {}).forEach(([k, v]) => e.setAttribute(k, v));
    if (文) e.textContent = 文;
    return e;
  };

  const 枠 = 作る('div', { class: 'アプリ内の案内', role: 'note' });
  const 文 = 作る('p', { class: 'アプリ内の案内_文' });
  let ボタン = null;
  if (アプリ === 'LINE') {
    const url = new URL(location.href);
    url.searchParams.set('openExternalBrowser', '1');
    文.textContent = 'LINE の中で開いています。うまく表示・送信できないときは、ふだんお使いのブラウザで開いてください（入力中の内容は消えます）。';
    ボタン = 作る('a', { class: 'アプリ内の案内_ボタン', href: url.toString() }, 'ブラウザで開く');
  } else if (Android) {
    文.textContent = `${アプリ} の中で開いています。うまく表示・送信できないときは、Chrome で開いてください（入力中の内容は消えます）。`;
    ボタン = 作る('a', {
      class: 'アプリ内の案内_ボタン',
      href: `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`,
    }, 'Chrome で開く');
  } else {
    文.textContent = `${アプリ} の中で開いています。うまく表示・送信できないときは、画面右上の「…」から「外部ブラウザで開く」を選んでください。`;
  }
  const 閉じる = 作る('button', { type: 'button', class: 'アプリ内の案内_閉じる', 'aria-label': '案内を閉じる' }, '×');
  閉じる.addEventListener('click', () => {
    枠.remove();
    try { sessionStorage.setItem(閉じた印, '1'); } catch (e) { /* 閉じるだけ */ }
  });
  枠.append(文);
  if (ボタン) 枠.append(ボタン);
  枠.append(閉じる);
  document.body.prepend(枠);
})();
