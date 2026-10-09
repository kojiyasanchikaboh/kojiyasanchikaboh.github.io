/**
 * 予約照会（お客様用。要件 5-2）
 * 受付番号と電話番号が一致した予約の、受取日時・お渡し・商品・合計・状態を表示する（POST lookup）
 * - URL の ?no=受付番号 で受付番号を入れておける（完了画面・受付メールのリンク）。電話番号は毎回入力してもらう
 * - 開いたときに config を呼び、GAS の起動し直しを先に済ませる（照会を押したときに待たせないため）。問い合わせ先のリンクにも使う
 * - 表示する文字は textContent で入れる
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const 円 = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;

  /** 受付番号：全角を半角に。数字だけ（9〜10桁）なら6桁目のあとにハイフンを入れる */
  function 受付番号を整える(s) {
    const t = s.normalize('NFKC').replace(/[‐－―−ー]/g, '-').replace(/\s/g, '');
    const 数字 = t.replace(/[^0-9]/g, '');
    if (/^\d{6}-\d{3,4}$/.test(t)) return t;
    if (/^\d{9,10}$/.test(数字)) return `${数字.slice(0, 6)}-${数字.slice(6)}`;
    return t;
  }

  // 開いたときに config を呼ぶ（起動し直しを先に済ませる。失敗しても照会はできる）
  API.設定を取る().then((設定) => {
    if (!設定 || !設定.ok) return;
    [['Instagramへ', 設定.InstagramのURL], ['LINEへ', 設定.公式LINEのURL]].forEach(([id, url]) => {
      if (url && /^https:\/\//.test(url)) { $(id).href = url; $(id).hidden = false; }
    });
  }).catch(() => { /* リンクを出さないだけ */ });

  // ?no=受付番号
  const 番号 = new URLSearchParams(location.search).get('no');
  if (番号) $('入力_受付番号').value = 受付番号を整える(番号).slice(0, 20);

  $('入力_受付番号').addEventListener('blur', (e) => { e.target.value = 受付番号を整える(e.target.value); });
  $('入力_電話番号').addEventListener('blur', (e) => { e.target.value = e.target.value.normalize('NFKC').replace(/[‐－―−ー]/g, '-').trim(); });
  ['受付番号', '電話番号'].forEach((k) => $(`入力_${k}`).addEventListener('input', () => { $(`エラー_${k}`).hidden = true; }));

  function エラーを出す(項目, 文) {
    $(`エラー_${項目}`).textContent = 文;
    $(`エラー_${項目}`).hidden = false;
    $(`入力_${項目}`).focus();
  }

  let 照会中 = false;

  $('照会').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (照会中) return;
    ['受付番号', '電話番号'].forEach((k) => { $(`エラー_${k}`).hidden = true; });
    $('照会のエラー').hidden = true;

    const 受付番号 = 受付番号を整える($('入力_受付番号').value);
    $('入力_受付番号').value = 受付番号;
    const 電話番号 = $('入力_電話番号').value.normalize('NFKC').trim();
    if (!受付番号) return エラーを出す('受付番号', '受付番号を入力してください');
    if (!/^\d{6}-\d{3,4}$/.test(受付番号)) return エラーを出す('受付番号', '受付番号を正しく入力してください（例：261008-001）');
    if (!電話番号) return エラーを出す('電話番号', '電話番号を入力してください');
    if (!/^0[0-9]{9,10}$/.test(電話番号.replace(/[^0-9]/g, ''))) return エラーを出す('電話番号', '電話番号を正しく入力してください（例：090-1234-5678）');

    照会中 = true;
    $('照会ボタン').disabled = true;
    $('照会中').hidden = false;
    let 結果;
    try {
      結果 = await API.送る({ action: 'lookup', 照会: { 受付番号, 電話番号 } }, 45);
    } catch (err) {
      結果 = { ok: false, エラー: err && err.種類 === '時間切れ'
        ? '時間がかかっています。電波の良いところで、もう一度お試しください。'
        : '通信できませんでした。インターネットにつながっているかご確認のうえ、もう一度お試しください。' };
    }
    照会中 = false;
    $('照会ボタン').disabled = false;
    $('照会中').hidden = true;

    if (!結果 || !結果.ok) {
      $('照会のエラー').textContent = (結果 && 結果.エラー) || 'ご予約を確認できませんでした。もう一度お試しください。';
      $('照会のエラー').hidden = false;
      return;
    }
    結果を出す(結果.予約);
  });

  const 状態の説明 = {
    ご予約確定: 'ご予約は確定しています。ご来店をお待ちしております。',
    店舗で確認中: '店舗で内容を確認しています。確定のメールをお待ちください（2営業日以内にお送りします）。',
    キャンセル済み: 'このご予約はキャンセルされています。',
  };

  function 結果を出す(予約) {
    $('結果_受付番号').textContent = 予約.受付番号;
    $('結果_状態').textContent = 予約.状態;
    $('結果_状態').className = `照会_状態 状態_${予約.状態}`;
    $('結果_状態の説明').textContent = 状態の説明[予約.状態] || '';
    $('結果_受取').textContent = `${予約.受取日の表示}　${予約.受取時間帯}`.trim() || '—';
    $('結果_お渡し').textContent = 予約.お渡し || '—';
    let 点数 = 0;
    $('結果_商品').replaceChildren(...予約.商品.map((p) => {
      点数 += p.数量;
      const li = document.createElement('li');
      const 名 = document.createElement('span');
      名.className = '確認_商品名';
      名.textContent = p.商品名;
      const 数 = document.createElement('span');
      数.className = '確認_数量';
      数.textContent = `${p.数量}個`;
      const 計 = document.createElement('span');
      計.className = '確認_小計';
      計.textContent = 円(p.小計);
      li.append(名, 数, 計);
      return li;
    }));
    $('結果_点数').textContent = `${点数}点`;
    $('結果_金額').textContent = 円(予約.合計金額);
    $('照会の入力').hidden = true;
    $('照会の結果').hidden = false;
    window.scrollTo(0, 0);
  }

  $('別の予約').addEventListener('click', () => {
    $('照会の結果').hidden = true;
    $('照会の入力').hidden = false;
    $('入力_受付番号').value = '';
    $('入力_電話番号').value = '';
    window.scrollTo(0, 0);
  });
})();
