/* Janus Event Tracer using Uptrace and OTEL (C) 2022 QXIP BV */

/* eslint-disable camelcase */
/* eslint quotes: 0 */
/* eslint-disable quote-props */
/* eslint-disable dot-notation */

var base_filter = require('@pastash/pastash').base_filter
var util = require('util')
var logger = require('@pastash/pastash').logger

const QuickLRU = require('quick-lru')

const otel = require('@opentelemetry/api')
const uptrace = require('@uptrace/node')

function nano_now (date) { return parseInt(date.toString().padEnd(16, '0')) }

function FilterAppJanusTracer () {
  base_filter.BaseFilter.call(this)
  this.mergeConfig({
    name: 'AppJanusTracer',
    optional_params: ['debug', 'endpoint', 'bypass', 'service_name', 'filter'],
    default_values: {
      'endpoint': 'http://token@uptrace.host.ip:14318/<project_id>',
      'service_name': 'pastash-janus',
      'bypass': true,
      'filter': ["1", "128", "2", "4", "8", "16", "32", "64", "256"],
      'debug': false
    },
    start_hook: this.start.bind(this)
  })
}

util.inherits(FilterAppJanusTracer, base_filter.BaseFilter)

FilterAppJanusTracer.prototype.start = async function (callback) {
  // LRU to track across sessions
  this.lru = new QuickLRU({ maxSize: 10000, maxAge: 3600000, onEviction: false })
  this.otel = otel
  // logger.info('FILTER incoming', this.filter)
  var filterArray = []
  for (var i = 0; i < this.filter.length; i++) {
    // logger.info('FILTER', this.filter[i])
    filterArray.push([parseInt(this.filter[i]), "allow"])
  }
  this.filterMap = new Map(filterArray)
  // logger.info('FILTER 1', this.filterMap.has(1))
  // logger.info('FILTER 2', this.filterMap.has(2))
  // logger.info('FILTER 64', this.filterMap.has(64))
  uptrace
    .configureOpentelemetry({
      dsn: this.endpoint,
      serviceName: this.service_name,
      serviceVersion: '0.0.1'
    })
    .start()
    .then(callback.bind(this))
}

FilterAppJanusTracer.prototype.process = async function (data) {
  /* check if we already have a global tracer */
  var tracer
  if (this.lru.has('tracer_instance')) {
    /* if yes, return current tracer */
    tracer = this.lru.get('tracer_instance')
  } else {
    /* if not, create a new tracer */
    tracer = otel.trace.getTracer('pastash_janus_uptrace', 'v0.0.1')
    this.lru.set('tracer_instance', tracer)
  }

  // logger.info('PJU -- Tracer tracking event', this.lru.has('tracer_instance'))

  // bypass
  if (this.bypass) this.emit('output', data)
  if (!data.message) return
  var event = {}
  var line = JSON.parse(data.message)
  logger.info('Incoming line', line.type, line.event)
  /* Ignore all other events */
  if (!this.filterMap.has(line.type)) return
  logger.info('Filtered', line.type, line.session_id, line.handle_id)
  /*
  TYPE 1 - Session related event
  Create Session and Destroy Session events are traced
  */
  if (line.type == 1) {
    event = {
      name: line.event.name,
      event: line.event.name,
      session_id: line?.session_id?.toString() || line?.session_id,
      timestamp: line.timestamp || nano_now(new Date().getTime())
    }
    /* CREATE event */
    if (event.name === "created") {
      const sessionSpan = tracer.startSpan("Session", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      })
      sessionSpan.setAttribute('service.name', 'Session')
      // logger.info('PJU -- Session event:', sessionSpan)
      this.lru.set("sess_" + event.session_id, sessionSpan)
    /* DESTROY event */
    } else if (event.name === "destroyed") {
      const sessionSpan = this.lru.get("sess_" + event.session_id)
      // logger.info('PJU -- Sending span', sessionSpan)
      const ctx = otel.trace.setSpan(otel.context.active(), sessionSpan)
      const destroySpan = tracer.startSpan("Session destroyed", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      destroySpan.setAttribute('service.name', 'Session')
      destroySpan.end()
      sessionSpan.end()
      this.lru.delete("sess_" + event.session_id)
    }
  /*
  TYPE 2 - Handle related event
  Handle Attachment and Detachment is traced
  */
  } else if (line.type == 2) {
    event = {
      name: line.event.name,
      event: line.event.name,
      session_id: line?.session_id?.toString() || line?.session_id,
      id: line?.session_id,
      timestamp: line.timestamp || nano_now(new Date().getTime())
    }
    /*
      Attach Event
      */
    if (event.name === "attached") {
      const sessionSpan = this.lru.get("sess_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), sessionSpan)
      const attachedSpan = tracer.startSpan("Handle attached", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      attachedSpan.setAttribute('service.name', 'Handle')
      this.lru.set("att_" + event.session_id, attachedSpan)
      /*
      Detach Event
      */
    } else if (event.name === "detached") {
      const attachedSpan = this.lru.get("att_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), attachedSpan)
      const detachedSpan = tracer.startSpan("Handle detached", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      detachedSpan.setAttribute('service.name', 'Handle')
      detachedSpan.end()
      attachedSpan.end()
    }
  /*
    Type 4 - External event
    */
  } else if (line.type == 4) {
    event = {
      name: "External Event",
      event: "External Event",
      session_id: line?.session_id?.toString() || line?.session_id,
      id: line?.session_id,
      timestamp: line.timestamp || nano_now(new Date().getTime())
    }
    const sessionSpan = this.lru.get("sess_" + event.session_id)
    const ctx = otel.trace.setSpan(otel.context.active(), sessionSpan)
    const extSpan = tracer.startSpan("External Event", {
      attributes: event,
      kind: otel.SpanKind.SERVER
    }, ctx)
    extSpan.setAttribute('service.name', 'External')
    extSpan.end()
  /*
    Type 8 - JSEP event
    */
  } else if (line.type == 8) {
    event = {
      name: line?.jsep?.type,
      event: line?.owner,
      session_id: line?.session_id?.toString() || line?.session_id,
      sdp: line?.jsep?.sdp || 'null',
      id: line?.session_id,
      timestamp: line.timestamp || nano_now(new Date().getTime())
    }
    /*
      Remote SDP
    */
    if (event.owner == "remote") {
      const sessionSpan = this.lru.get("sess_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), sessionSpan)
      const sdpSpan = tracer.startSpan("JSEP Event - " + event.owner, {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      sdpSpan.setAttribute('service.name', 'JSEP')
      sdpSpan.end()
    /*
      Local SDP
    */
    } else if (event.owner == "owner") {
      const sessionSpan = this.lru.get("sess_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), sessionSpan)
      const sdpSpan = tracer.startSpan("JSEP Event - " + event.owner, {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      sdpSpan.setAttribute('service.name', 'JSEP')
      sdpSpan.end()
    }
  /*
    Type 16 - WebRTC state event
    */
  } else if (line.type == 16) {
    /*
      Subtype 1
      ICE flow
    */
    if (line.subtype == 1) {
      event = {
        name: "Ice Flow",
        event: line?.event?.ice,
        session_id: line?.session_id?.toString() || line?.session_id,
        ice_state: line?.event?.ice || 'null',
        id: line?.session_id,
        timestamp: line.timestamp || nano_now(new Date().getTime())
      }
      if (event.ice_state == "gathering") {
        const sessionSpan = this.lru.get("sess_" + event.session_id)
        const ctx = otel.trace.setSpan(otel.context.active(), sessionSpan)
        const iceSpan = tracer.startSpan("ICE gathering", {
          attributes: event,
          kind: otel.SpanKind.SERVER
        }, ctx)
        this.lru.set("ice_" + event.session_id, iceSpan)

      } else if (event.ice_state == "connecting") {
        const iceSpan = this.lru.get("ice_" + event.session_id)
        const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
        const conIceSpan = tracer.startSpan("ICE connecting", {
          attributes: event,
          kind: otel.SpanKind.SERVER
        }, ctx)
        conIceSpan.end()

      } else if (event.ice_state == "connected") {
        const iceSpan = this.lru.get("ice_" + event.session_id)
        const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
        const conIceSpan = tracer.startSpan("ICE connected", {
          attributes: event,
          kind: otel.SpanKind.SERVER
        }, ctx)
        conIceSpan.end()

      } else if (event.ice_state == "ready") {
        const iceSpan = this.lru.get("ice_" + event.session_id)
        const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
        const readySpan = tracer.startSpan("ICE connected", {
          attributes: event,
          kind: otel.SpanKind.SERVER
        }, ctx)
        readySpan.end()
        iceSpan.end()
      }
    /*
      Subtype 2
      Local Candidates
    */
    } else if (line.subtype == 2) {
      event = {
        name: "Local Candidates",
        session_id: line?.session_id?.toString() || line?.session_id,
        candidate: line?.event["local-candidate"],
        id: line?.session_id,
        timestamp: line.timestamp || nano_now(new Date().getTime())
      }
      const iceSpan = this.lru.get("ice_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
      const candidateSpan = tracer.startSpan("Local Candidate", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      candidateSpan.end()

    /*
      Subtype 3
      Remote Candidates
    */
    } else if (line.subtype == 3) {
      event = {
        name: "Remote Candidates",
        session_id: line?.session_id?.toString() || line?.session_id,
        candidate: line?.event["remote-candidate"],
        id: line?.session_id,
        timestamp: line.timestamp || nano_now(new Date().getTime())
      }
      const iceSpan = this.lru.get("ice_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
      const candidateSpan = tracer.startSpan("Remote Candidate", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      candidateSpan.end()
    /*
      Subtype 4
      Connection Selected
    */
    } else if (line.subtype == 4) {
      event = {
        name: "Candidates selected",
        event: JSON.stringify(line?.event),
        session_id: line?.session_id?.toString() || line?.session_id,
        id: line?.session_id,
        timestamp: line.timestamp || nano_now(new Date().getTime())
      }
      const iceSpan = this.lru.get("ice_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
      const candidateSpan = tracer.startSpan("Selected Candidates", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      candidateSpan.end()

    /*
      Subtype 5
      DTLS flow
    */
    } else if (line.subtype == 5) {
      event = {
        name: "DTLS flow",
        event: line?.event?.dtls,
        session_id: line?.session_id?.toString() || line?.session_id,
        id: line?.session_id,
        timestamp: line.timestamp || nano_now(new Date().getTime())
      }
      /*
        trying
      */
      if (event.event == "trying") {
        const iceSpan = this.lru.get("ice_" + event.session_id)
        const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
        const trySpan = tracer.startSpan("DTLS trying", {
          attributes: event,
          kind: otel.SpanKind.SERVER
        }, ctx)
        trySpan.end()
      /*
        connected
      */
      } else if (event.event == "connected") {
        const iceSpan = this.lru.get("ice_" + event.session_id)
        const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
        const conSpan = tracer.startSpan("DTLS connected", {
          attributes: event,
          kind: otel.SpanKind.SERVER
        }, ctx)
        conSpan.end()
      }
    /*
      Subtype 6
      Connection Up
    */
    } else if (line.subtype == 6) {
      event = {
        name: "Connection Up",
        event: line?.event,
        session_id: line?.session_id?.toString() || line?.session_id,
        id: line?.session_id,
        timestamp: line.timestamp || nano_now(new Date().getTime())
      }
      const iceSpan = this.lru.get("ice_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), iceSpan)
      const conSpan = tracer.startSpan("WebRTC Connection UP", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      conSpan.end()
    }
  /*
    Type 32 - Media Report
  */
  } else if (line.type == 32) {

  } else if (line.type == 128) {

  } else if (line.type == 256) {

  }
  /*
  TYPE 64 - Plugin-originated event

  Users Joining or Leaving Sessions
  */
  } else if (line.type == 64) {
    event = {
      name: line.event.plugin,
      event: line.event.data.event,
      display: line.event.data?.display || 'null',
      id: line.event.data.id.toString(),
      session_id: line?.session_id?.toString() || line.session_id,
      room: line.event.data.room?.toString() || line.event.data.room,
      timestamp: line.timestamp || nano_now(new Date().getTime())
    }
    if (!line.event.data) return
    // logger.info("trace 64: ", line)
    /*
      Joined Event
      */
    if (event.event === "joined") {
      const sessionSpan = this.lru.get("sess_" + event.session_id)
      const ctx = otel.trace.setSpan(otel.context.active(), sessionSpan)
      const joinSpan = tracer.startSpan("User joined", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      joinSpan.setAttribute('service.name', 'Plugin')
      this.lru.set("join_" + event.id, joinSpan)
      /*
      Configured Event
      */
    } else if (event.event === "configured") {
      const joinSpan = this.lru.get('join_' + event.id)
      const ctx = otel.trace.setSpan(otel.context.active(), joinSpan)
      const confSpan = tracer.startSpan("User configured", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      confSpan.setAttribute('service.name', 'Plugin')
      this.lru.set("conf_" + event.id, confSpan)
      /*
      Published Event
      */
    } else if (event.event === "published") {
      const joinSpan = this.lru.get('join_' + event.id)
      const ctx = otel.trace.setSpan(otel.context.active(), joinSpan)
      const pubSpan = tracer.startSpan("User published", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      pubSpan.setAttribute('service.name', 'Plugin')
      this.lru.set("pub_" + event.id, pubSpan)

      const confSpan = this.lru.get('conf_' + event.id)
      confSpan.end()
      /*
      Subscribing Event
      */
    } else if (event.event === "subscribing") {
      const joinSpan = this.lru.get('join_' + event.id)
      const ctx = otel.trace.setSpan(otel.context.active(), joinSpan)
      const subSpan = tracer.startSpan("User subscribing", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      subSpan.setAttribute('service.name', 'Plugin')
      this.lru.set("sub_" + event.session_id, subSpan)
      /*
      Subscribed Event
      */
    } else if (event.event === "subscribed") {
      const subSpan = this.lru.get('sub_' + event.session_id)
      subSpan.end()
      /*
      Update Event
      */
    } else if (event.event === "updated") {
      const joinSpan = this.lru.get('join_' + event.id)
      const ctx = otel.trace.setSpan(otel.context.active(), joinSpan)
      const upSpan = tracer.startSpan("User updated", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      upSpan.setAttribute('service.name', 'Plugin')
      upSpan.end()
      /*
      Unpublished Event
      */
    } else if (event.event === "unpublished") {
      const joinSpan = this.lru.get('join_' + event.id)
      const ctx = otel.trace.setSpan(otel.context.active(), joinSpan)
      const unpubSpan = tracer.startSpan("User unpublished", {
        attributes: event,
        kind: otel.SpanKind.SERVER
      }, ctx)
      unpubSpan.setAttribute('service.name', 'Plugin')
      unpubSpan.end()
      const pubSpan = this.lru.get('pub_' + event.id)
      pubSpan.end()
      /*
      Leaving Event
      */
    } else if (event.event === "leaving") {
      // correlate: event.data.id --> session_id
      try {
        const joinSpan = this.lru.get('join_' + event.id)
        const ctx = otel.trace.setSpan(otel.context.active(), joinSpan)
        const leaveSpan = tracer.startSpan("User leaving", {
          attributes: event,
          kind: otel.SpanKind.SERVER
        }, ctx)
        leaveSpan.setAttribute('service.name', 'Plugin')
        leaveSpan.end()
        joinSpan.end()
      } catch (e) {
        console.log(e)
      }
    }
  }
}

exports.create = function () {
  return new FilterAppJanusTracer()
}

/* promise wrapper */
