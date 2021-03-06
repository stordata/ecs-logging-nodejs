// Licensed to Elasticsearch B.V. under one or more contributor
// license agreements. See the NOTICE file distributed with
// this work for additional information regarding copyright
// ownership. Elasticsearch B.V. licenses this file to you under
// the Apache License, Version 2.0 (the "License"); you may
// not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

'use strict'

const { MESSAGE } = require('triple-beam')
const { format } = require('winston')
const {
  version,
  stringify,
  formatError,
  formatHttpRequest,
  formatHttpResponse
} = require('@elastic/ecs-helpers')

// We will query the Elastic APM agent if it is available.
let elasticApm = null
try {
  elasticApm = require('elastic-apm-node')
} catch (ex) {
  // Silently ignore.
}

const reservedFields = {
  level: true,
  'log.level': true,
  ecs: true,
  '@timestamp': true,
  err: true,
  req: true,
  res: true
}

// https://github.com/winstonjs/winston#creating-custom-formats
function ecsTransform (info, opts) {
  // Boolean options for whether to specially handle some logged field names:
  //  - `err` to ECS Error fields
  //  - `req` and `res` to ECS HTTP, User agent, etc. fields
  let convertErr = true
  let convertReqRes = false
  // istanbul ignore else
  if (opts) {
    if (hasOwnProperty.call(opts, 'convertErr')) {
      convertErr = opts.convertErr
    }
    if (hasOwnProperty.call(opts, 'convertReqRes')) {
      convertReqRes = opts.convertReqRes
    }
  }

  const ecsFields = {
    '@timestamp': new Date().toISOString(),
    'log.level': info.level,
    message: info.message,
    ecs: { version }
  }

  // Add all unreserved fields.
  const keys = Object.keys(info)
  for (let i = 0, len = keys.length; i < len; i++) {
    const key = keys[i]
    if (!reservedFields[key]) {
      ecsFields[key] = info[key]
    }
  }

  // If there is a *started* APM agent, then use it.
  const apm = elasticApm && elasticApm.isStarted() ? elasticApm : null

  // istanbul ignore else
  if (apm) {
    // Set "service.name" and "event.dataset" from APM conf, if not already set.
    let serviceName = ecsFields.service && ecsFields.service.name
    if (!serviceName) {
      // https://github.com/elastic/apm-agent-nodejs/pull/1949 is adding
      // getServiceName() in v3.11.0. Fallback to private `apm._conf`.
      // istanbul ignore next
      serviceName = apm.getServiceName
        ? apm.getServiceName()
        : apm._conf.serviceName
      // A mis-configured APM Agent can be "started" but not have a
      // "serviceName".
      if (serviceName) {
        ecsFields.service = ecsFields.service || {}
        ecsFields.service.name = serviceName
      }
    }
    if (serviceName && !(ecsFields.event && ecsFields.event.dataset)) {
      ecsFields.event = ecsFields.event || {}
      ecsFields.event.dataset = serviceName + '.log'
    }

    // https://www.elastic.co/guide/en/ecs/current/ecs-tracing.html
    const tx = apm.currentTransaction
    if (tx) {
      ecsFields.trace = ecsFields.trace || {}
      ecsFields.trace.id = tx.traceId
      ecsFields.transaction = ecsFields.transaction || {}
      ecsFields.transaction.id = tx.id
      const span = apm.currentSpan
      // istanbul ignore else
      if (span) {
        ecsFields.span = ecsFields.span || {}
        ecsFields.span.id = span.id
      }
    }
  }

  // https://www.elastic.co/guide/en/ecs/current/ecs-error.html
  if (info.err !== undefined) {
    if (convertErr) {
      formatError(ecsFields, info.err)
    } else {
      ecsFields.err = info.err
    }
  }

  // https://www.elastic.co/guide/en/ecs/current/ecs-http.html
  if (info.req !== undefined) {
    if (convertReqRes) {
      formatHttpRequest(ecsFields, info.req)
    } else {
      ecsFields.req = info.req
    }
  }
  if (info.res !== undefined) {
    if (convertReqRes) {
      formatHttpResponse(ecsFields, info.res)
    } else {
      ecsFields.res = info.res
    }
  }

  info[MESSAGE] = stringify(ecsFields)
  return info
}

module.exports = format(ecsTransform)
