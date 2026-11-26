'use strict';

const { publicStatus } = require('../lib/config');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Cache-Control', 'no-store');
  const status = publicStatus();
  res.status(200).json({
    ok: true,
    service: 'salesprep',
    ...status,
    // 事实采集走 /api/facts；这里如实告诉排查者当前用的是哪个数据源
    search: Boolean(status.factsSource),
    factsApi: '/api/facts',
    time: new Date().toISOString()
  });
};
