import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWerssArticleRecord,
  canonicalizeWechatArticleUrl,
  extractWerssFeedId,
  getPeerDiscoveryWindow,
  makeWerssArticleId,
  normalizeDajialaResponse,
  resolveDajialaLookup,
} from "../lib/peer-wechat-discovery.mjs";

test("uses a fixed previous-day 06:30 to report-day 06:30 window", () => {
  const window = getPeerDiscoveryWindow("2026-08-07");
  assert.equal(window.windowStartIso, "2026-08-05T22:30:00.000Z");
  assert.equal(window.windowEndIso, "2026-08-06T22:30:00.000Z");
  assert.throws(() => getPeerDiscoveryWindow("2026-02-30"), /invalid/);
});

test("normalizes the observed flat Dajiala response", () => {
  const normalized = normalizeDajialaResponse({
    code: 0,
    cost_money: 0.16,
    remain_money: 0.54,
    offset: "next",
    is_end: 0,
    nickname: "亨瑞出国",
    ghid: "henrygroup1992",
    data: [{
      position: 3,
      url: "https://mp.weixin.qq.com/s?__biz=abc&mid=2650895023&idx=3&sn=xyz&scene=1",
      post_time: 1786000000,
      title: "测试文章",
      digest: "摘要",
      appmsgid: "2650895023",
    }],
  });
  assert.equal(normalized.costMoney, 0.16);
  assert.equal(normalized.articles[0].position, 3);
  assert.equal(normalized.articles[0].url, "https://mp.weixin.qq.com/s?__biz=abc&mid=2650895023&idx=3&sn=xyz");
});

test("also accepts the documented nested response shape", () => {
  const normalized = normalizeDajialaResponse({
    code: 0,
    data: {
      MsgList: {
        Msg: [{
          position: "1",
          url: "https://mp.weixin.qq.com/s?__biz=abc&mid=123456&idx=1&sn=token",
          post_time: "1786000000",
          title: "嵌套格式",
          appmsgid: "123456",
        }],
      },
      PagingInfo: { Offset: "nested-next", IsEnd: 1 },
      cost: 0.14,
    },
  });
  assert.equal(normalized.offset, "nested-next");
  assert.equal(normalized.isEnd, true);
  assert.equal(normalized.articles[0].title, "嵌套格式");
  assert.equal(normalized.remainMoney, null);
});

test("builds IDs compatible with existing WeRSS rows", () => {
  assert.equal(extractWerssFeedId("https://host/feed/MP_WXS_2390329593.rss"), "MP_WXS_2390329593");
  assert.equal(makeWerssArticleId("MP_WXS_2390329593", "2650895023", 3), "2390329593-2650895023_3");
  const record = buildWerssArticleRecord("MP_WXS_2390329593", {
    position: 3,
    url: "https://mp.weixin.qq.com/s?__biz=abc&mid=2650895023&idx=3&sn=xyz",
    post_time: 1786000000,
    title: "测试文章",
    appmsgid: "2650895023",
  }, 1786000200);
  assert.equal(record.id, "2390329593-2650895023_3");
  assert.equal(record.publishInfo.position, 3);
});

test("leaves non-WeChat URLs unchanged", () => {
  assert.equal(canonicalizeWechatArticleUrl("https://example.com/a?x=1"), "https://example.com/a?x=1");
});

test("supports explicit nickname lookup without silently falling back", () => {
  assert.deepEqual(resolveDajialaLookup({
    lookupMode: "nickname",
    ghid: "unused-ghid",
    nickname: "深圳桉侨移民",
    articleUrl: "https://mp.weixin.qq.com/s/example",
  }), {
    mode: "nickname",
    ghid: "",
    articleUrl: "",
    nickname: "深圳桉侨移民",
  });
  assert.throws(
    () => resolveDajialaLookup({ lookupMode: "nickname", articleUrl: "https://mp.weixin.qq.com/s/example" }),
    /requires nickname/,
  );
});

test("auto lookup prefers ghid, then URL, then nickname", () => {
  assert.equal(resolveDajialaLookup({ lookupMode: "auto", ghid: "account-id", articleUrl: "url", nickname: "name" }).mode, "ghid");
  assert.equal(resolveDajialaLookup({ lookupMode: "auto", articleUrl: "url", nickname: "name" }).mode, "url");
  assert.equal(resolveDajialaLookup({ lookupMode: "auto", nickname: "name" }).mode, "nickname");
});
