/**
 * 予約API（GAS）との通信
 * - Content-Type を付けない（text/plain になり、プリフライトが起きない。CLAUDE.md 2-3）
 * - 待ち時間の上限を付ける。時間切れと通信の失敗は 種類 で区別して投げる
 */
const API = (() => {
  /** 画面で区別して案内するためのエラー（種類：'時間切れ'｜'通信'） */
  function 通信エラー(種類) {
    const e = new Error(種類);
    e.種類 = 種類;
    return e;
  }

  async function 呼ぶ(url, 送り方, 待ち秒) {
    const 中断 = new AbortController();
    const タイマー = setTimeout(() => 中断.abort(), 待ち秒 * 1000);
    try {
      const 応答 = await fetch(url, Object.assign({ redirect: 'follow', signal: 中断.signal }, 送り方));
      if (!応答.ok) throw 通信エラー('通信');
      return await 応答.json();
    } catch (err) {
      if (err && err.種類) throw err;
      if (err && err.name === 'AbortError') throw 通信エラー('時間切れ');
      throw 通信エラー('通信');
    } finally {
      clearTimeout(タイマー);
    }
  }

  return {
    /** 店名・お知らせ・選べる受取日・時間帯・商品カード */
    // しばらく使われていないと、GAS の起動し直しで 10〜25秒かかることがある（10/08 実測）。ふだんは2〜3秒
    設定を取る: () => 呼ぶ(`${API_URL}?action=config`, {}, 45),
    /** 受付期間のすべての日の空き状況（商品の上限・区分の残り・時間帯の混雑）をまとめて（要件 No.36） */
    暦を取る: () => 呼ぶ(`${API_URL}?action=calendar`, {}, 45),
    /** 指定日の商品の上限・受付終了・区分の残り・時間帯の混雑 */
    空きを取る: (日付) => 呼ぶ(`${API_URL}?action=availability&date=${encodeURIComponent(日付)}`, {}, 30),
    /** POST（本文は JSON の文字） */
    送る: (本文, 待ち秒) => 呼ぶ(API_URL, { method: 'POST', body: JSON.stringify(本文) }, 待ち秒),
  };
})();
