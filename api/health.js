'use strict';

const { publicStatus } = require('../lib/config');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    service: 'fxhy-live',
    ...publicStatus(),
    time: new Date().toISOString()
  });
};
