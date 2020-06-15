'use strict';

const Buffer = require('safe-buffer').Buffer;
const crypto = require('crypto');
const moment = require('moment');
const objectAssign = require('object-assign');
const https = require('https');
const encodeFormData = require('./encode-form-data');

const defaultHost = 'news-api.apple.com';

module.exports = function (config) {
  async function sendRequest (method, endpoint, post, cb) {
    // handle alert notifications w/ custom headers
    const isAlert = post && post.data && post.data.alertBody;
    const headers = post ? (isAlert ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(post))} : post.headers) : {};

    const host = config.host || defaultHost;
    const date = moment().utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
    let canonicalRequest = Buffer(method + 'https://' + host + endpoint + date +
      (headers['content-type'] ? headers['content-type'] : ''), 'ascii');

    if (post) {
      canonicalRequest = Buffer.concat([canonicalRequest, isAlert ? Buffer.from(JSON.stringify(post), 'utf-8') : post.buffer]);
    }

    const key = new Buffer(config.apiSecret, 'base64');
    const signature = crypto.createHmac('sha256', key)
      .update(canonicalRequest, 'utf8')
      .digest('base64');
    const auth = 'HHMAC; key="' + config.apiId +
      '"; signature="' + signature +
      '"; date="' + date + '"';

    const opts = {
      method: method,
      host: host,
      port: config.port || void 0,
      rejectUnauthorized: process.env.NODE_ENV !== 'test',
      path: endpoint,
      headers: objectAssign({
        Accept: 'application/json',
        Authorization: auth
      }, headers)
    };

    const req = await https.request(opts);
    req.setTimeout(config.timeout || 0);

    // abort request on timeout
    req.on('timeout', function () {
      req.abort();
    });

    req.on('error', function (err) {
      // handle socket timeout
      if (err.code === 'ECONNRESET') {
        cb(new Error('Apple News API endpoint timeout after ' + config.timeout + ' ms'));
      } else {
        cb(err);
      }
    });

    req.on('response', function (res) {
      let result = '';
      let done = false;

      res.on('data', function (chunk) {
        result += chunk.toString();
      });

      res.on('error', function (err) {
        if (!done) {
          done = true;
          cb(err);
        }
      });

      res.on('end', function () {
        if (!done) {
          done = true;
          let parsed = null;

          if (!result) {
            return cb(null, res, null);
          }

          try {
            parsed = JSON.parse(result);
          } catch (e) {
            return cb(e);
          }

          if (parsed.data) {
            return cb(null, res, parsed.data);
          }

          if (parsed.errors && Array.isArray(parsed.errors) &&
              parsed.errors.length > 0 && parsed.errors[0].code) {
            const e = new Error(result);
            e.apiError = parsed.errors[0];
            return cb(e);
          }

          return cb(new Error(result));
        }
      });
    });

    if (post) {
      req.write(isAlert ? JSON.stringify(post) : post.buffer);
    }

    req.end();
  }

  return function makeRequest (method, endpoint, requestOpts, cb) {
    const done = function (err, res, body) {
      if (err) {
        return cb(err);
      }

      // Endpoint returns 2XX on success
      if (String(res.statusCode)[0] !== '2') {
        return cb(new Error(method + ' ' + endpoint + ' code ' + res.statusCode));
      }

      return cb(null, body);
    };

    if (method === 'POST' && requestOpts.formData) {
      if (requestOpts.formData.data && requestOpts.formData.data.alertBody) {
        return sendRequest(method, endpoint, requestOpts.formData, done);
      } else {
        return encodeFormData(requestOpts.formData || {}, function (err, encoded) {
          if (err) {
            return done(err);
          }

          sendRequest(method, endpoint, encoded, done);
        });
      }
    }

    sendRequest(method, endpoint, null, done);
  };
};