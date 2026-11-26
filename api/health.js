'use strict';

const { publicStatus } = require('../lib/config');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Cache-Control', 'no-store');

  const status = publicStatus();

  /*
   * 自检入口：/api/health?probe=1[&company=企业全称]
   *
   * 取数失败时，业务报错只能说明"没查到"，说不出是没会话、形态不对还是真没这家企业。
   * 这里按真实链路逐步打一次网关，把每一步的 HTTP 状态与原响应摘要摊开——
   * 一次调用就能定位，不用再靠猜。
   * 注意：会真实消耗 3~4 次快查额度，只在排查时用。
   */
  let probeResult;
  if (/[?&]probe=1(?:&|$)/.test(String(req.url || ''))) {
    try {
      const { probe } = require('../lib/kuaicha');
      const m = String(req.url || '').match(/[?&]company=([^&]+)/);
      probeResult = await probe(m ? decodeURIComponent(m[1]) : '');
    } catch (e) {
      probeResult = { ok: false, error: `${e.code || ''} ${e.message}`.trim() };
    }
  }

  res.status(200).json({
    ok: true,
    service: 'salesprep',
    ...status,
    // 事实采集走 /api/facts；这里如实告诉排查者当前用的是哪个数据源
    search: Boolean(status.factsSource),
    factsApi: '/api/facts',
    ...(probeResult ? { probe: probeResult } : {}),
    time: new Date().toISOString()
  });
};
