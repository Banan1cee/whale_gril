'use strict';

const { statusPayload } = require('../../services/status');
const { json } = require('../util');

module.exports = function register(router) {
  router.get('/api/status', (runtime, req, res) => json(res, 200, statusPayload(runtime)));
};
