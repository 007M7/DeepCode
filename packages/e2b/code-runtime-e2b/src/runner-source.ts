/** Dependency-free remote code runner installed inside the E2B sandbox. */

/** Node program that runs one model program in a fresh remote worker thread. */
export const CODE_RUNNER_SOURCE = String.raw`import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import { inspect } from 'node:util'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const emitFrame = message => {
  process.stdout.write(Buffer.from(JSON.stringify(message)).toString('base64') + '\n')
}

const parseFrame = line => JSON.parse(Buffer.from(line, 'base64').toString('utf8'))

const waitForPipeDrain = stream => {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      stream.off('end', done)
      stream.off('close', done)
      stream.off('error', done)
      resolve()
    }
    stream.once('end', done)
    stream.once('close', done)
    stream.once('error', done)
    if (stream.readableEnded || stream.destroyed) done()
  })
}

const waitForChildExit = child => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => { child.once('exit', resolve) })
}

const jsonStringBytes = text => Buffer.byteLength(JSON.stringify(text))

const truncateLog = (text, available) => {
  if (available < 2) return ''
  let result = ''
  let bytes = 2
  for (const character of text) {
    const cost = jsonStringBytes(character) - 2
    if (bytes + cost > available) break
    bytes += cost
    result += character
  }
  return result
}

const runLauncher = () => {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let controller
  let maxOutputBytes = 0
  let logBytes = 2
  let logEntries = 0
  let settling = false
  let closed = false
  let terminal

  const finish = message => {
    if (settling) {
      if (message.type === 'output-limit') terminal = message
      return
    }
    settling = true
    terminal = message
    const current = controller
    controller = undefined
    const drain = current
      ? new Promise(resolve => { setImmediate(resolve) }).then(async () => {
          const stdoutDrained = waitForPipeDrain(current.stdout)
          const stderrDrained = waitForPipeDrain(current.stderr)
          const exited = waitForChildExit(current)
          current.kill('SIGKILL')
          await Promise.all([exited, stdoutDrained, stderrDrained])
        })
      : Promise.resolve()
    void drain.catch(error => {
      process.stderr.write('code-runtime-e2b controller cleanup error: ' + String(error) + '\n')
    }).then(() => {
      closed = true
      emitFrame(terminal)
      input.close()
      process.stdin.destroy()
    })
  }

  const forwardLog = text => {
    if (closed || terminal?.type === 'output-limit') return
    const separator = logEntries > 0 ? 1 : 0
    const available = maxOutputBytes - logBytes - separator
    const cost = jsonStringBytes(text)
    if (cost > available) {
      const prefix = truncateLog(text, available)
      if (prefix) {
        logBytes += jsonStringBytes(prefix) + separator
        logEntries += 1
        emitFrame({ type: 'log', text: prefix })
      }
      finish({ type: 'output-limit' })
      return
    }
    logBytes += cost + separator
    logEntries += 1
    emitFrame({ type: 'log', text })
  }

  const startController = message => {
    maxOutputBytes = message.maxOutputBytes
    controller = fork(fileURLToPath(import.meta.url), [], {
      env: { DSH_CODE_RUNTIME_CONTROLLER: '1' },
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const current = controller
    current.stdout.on('data', data => { forwardLog(data.toString('utf8')) })
    current.stderr.on('data', data => { forwardLog(data.toString('utf8')) })
    current.on('message', raw => {
      if (!raw || typeof raw !== 'object') return
      if (raw.type === 'log' && typeof raw.text === 'string') {
        forwardLog(raw.text)
        return
      }
      if (settling) return
      if (raw.type === 'call' && typeof raw.id === 'number' && typeof raw.global === 'string' && typeof raw.name === 'string' && Array.isArray(raw.args)) {
        emitFrame({ type: 'call', id: raw.id, global: raw.global, name: raw.name, args: raw.args })
      } else if (raw.type === 'output-limit') {
        finish({ type: 'output-limit' })
      } else if (raw.type === 'done') {
        if (raw.error && typeof raw.error === 'object' && typeof raw.error.kind === 'string' && typeof raw.error.message === 'string') {
          finish({ type: 'done', error: { kind: raw.error.kind, message: raw.error.message } })
        } else if (raw.value === undefined || Array.isArray(raw.value)) {
          finish({ type: 'done', ...(raw.value === undefined ? {} : { value: raw.value }) })
        }
      }
    })
    current.on('error', error => {
      finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote controller error: ' + error.message } })
    })
    current.on('exit', code => {
      if (!settling) finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote controller exited with code ' + code + ' before completing' } })
    })
    current.send(message, error => {
      if (error) finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote controller boot failed: ' + error.message } })
    })
  }

  input.on('line', line => {
    let message
    try {
      message = parseFrame(line)
    } catch (error) {
      process.stderr.write('code-runtime-e2b frame error: ' + String(error) + '\n')
      finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote runner received a malformed frame' } })
      return
    }
    if (!controller) {
      if (!message || message.type !== 'boot' || typeof message.code !== 'string' || !Array.isArray(message.namespaces) || !Number.isSafeInteger(message.maxOutputBytes) || message.maxOutputBytes < 4) {
        finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote runner received an invalid boot frame' } })
        return
      }
      startController(message)
      return
    }
    if (message && message.type === 'reply' && typeof message.id === 'number' && typeof message.ok === 'boolean') {
      controller.send(message.ok
        ? { type: 'reply', id: message.id, ok: true, value: message.value }
        : { type: 'reply', id: message.id, ok: false, message: String(message.message) }, error => {
          if (error) finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote controller reply failed: ' + error.message } })
        })
    }
  })
  input.on('close', () => { if (controller && !settling) controller.kill('SIGKILL') })
}

const runController = () => {
  let worker
  let finished = false
  let computeTimer
  const send = message => {
    if (process.send) process.send(message)
  }
  const finish = message => {
    if (finished) return
    finished = true
    clearInterval(computeTimer)
    const current = worker
    worker = undefined
    const drain = current
      ? new Promise(resolve => { setImmediate(resolve) }).then(async () => {
          const stdoutDrained = waitForPipeDrain(current.stdout)
          const stderrDrained = waitForPipeDrain(current.stderr)
          await Promise.all([current.terminate(), stdoutDrained, stderrDrained])
        })
      : Promise.resolve()
    void drain.catch(error => {
      send({ type: 'log', text: 'code-runtime-e2b worker cleanup error: ' + String(error) + '\n' })
    }).then(() => {
      if (!process.send) {
        process.exitCode = 1
        return
      }
      process.send(message, () => { if (process.connected) process.disconnect() })
    })
  }
  process.on('message', message => {
    if (!worker) {
      if (!message || message.type !== 'boot' || typeof message.code !== 'string' || !Array.isArray(message.namespaces)) {
        finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote controller received an invalid boot frame' } })
        return
      }
      worker = new Worker(new URL(import.meta.url), {
        workerData: message,
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: message.maxOldGenerationSizeMb },
      })
      worker.stdout.on('data', data => { send({ type: 'log', text: data.toString('utf8') }) })
      worker.stderr.on('data', data => { send({ type: 'log', text: data.toString('utf8') }) })
      worker.on('message', raw => {
        if (!raw || typeof raw !== 'object') return
        if (raw.type === 'call' && typeof raw.id === 'number' && typeof raw.global === 'string' && typeof raw.name === 'string' && Array.isArray(raw.args)) {
          send({ type: 'call', id: raw.id, global: raw.global, name: raw.name, args: raw.args })
        } else if (raw.type === 'log' && typeof raw.text === 'string') {
          send({ type: 'log', text: raw.text })
        } else if (raw.type === 'output-limit') {
          finish({ type: 'output-limit' })
        } else if (raw.type === 'done') {
          if (raw.error && typeof raw.error === 'object' && typeof raw.error.kind === 'string' && typeof raw.error.message === 'string') {
            finish({ type: 'done', error: { kind: raw.error.kind, message: raw.error.message } })
          } else if (raw.value === undefined || Array.isArray(raw.value)) {
            finish({ type: 'done', ...(raw.value === undefined ? {} : { value: raw.value }) })
          }
        }
      })
      worker.on('error', error => {
        finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote worker error: ' + error.message } })
      })
      worker.on('exit', code => {
        if (!finished) finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote worker exited with code ' + code + ' before completing' } })
      })
      computeTimer = setInterval(() => {
        if (!worker) return
        if (worker.performance.eventLoopUtilization().active > message.computeMs) {
          finish({ type: 'done', error: { kind: 'timeout', message: 'compute budget exhausted (' + message.computeMs + 'ms busy)' } })
        }
      }, 25)
      return
    }
    if (message && message.type === 'reply' && typeof message.id === 'number' && typeof message.ok === 'boolean') {
      worker.postMessage(message.ok
        ? { type: 'reply', id: message.id, ok: true, value: message.value }
        : { type: 'reply', id: message.id, ok: false, message: String(message.message) })
    }
  })
  process.on('disconnect', () => { if (worker && !finished) void worker.terminate() })
}

if (!isMainThread) {
  const port = parentPort
  if (!port) throw new Error('remote worker requires parentPort')

  const CapturedError = Error
  const ArrayIsArray = Array.isArray
  const ArrayPrototype = Array.prototype
  const ObjectPrototype = Object.prototype
  const ObjectCreate = Object.create
  const ObjectDefineProperty = Object.defineProperty
  const ObjectGetPrototypeOf = Object.getPrototypeOf
  const ObjectHasOwn = Object.hasOwn
  const ObjectKeys = Object.keys
  const ObjectIs = Object.is
  const ObjectPropertyIsEnumerable = Object.prototype.propertyIsEnumerable
  const ReflectOwnKeys = Reflect.ownKeys
  const ReflectApply = Reflect.apply
  const NumberIsFinite = Number.isFinite
  const NumberIsSafeInteger = Number.isSafeInteger
  const PromiseCtor = Promise
  const PromiseReject = Promise.reject
  const QueueMicrotask = queueMicrotask
  const BufferByteLength = Buffer.byteLength
  const SetCtor = Set
  const SetAdd = Set.prototype.add
  const SetDelete = Set.prototype.delete
  const SetHas = Set.prototype.has
  const MapDelete = Map.prototype.delete
  const MapGet = Map.prototype.get
  const MapSet = Map.prototype.set
  const ArrayJoin = Array.prototype.join
  const ArrayPop = Array.prototype.pop
  const StringCharCodeAt = String.prototype.charCodeAt
  const StringSlice = String.prototype.slice
  const JSONStringify = JSON.stringify
  const StringValue = String

  const define = (target, key, value) => {
    const descriptor = ObjectCreate(null)
    descriptor.value = value
    descriptor.enumerable = true
    descriptor.configurable = true
    descriptor.writable = true
    ObjectDefineProperty(target, key, descriptor)
  }
  const append = (target, value) => { define(target, target.length, value) }
  const pop = target => ReflectApply(ArrayPop, target, [])
  const setAdd = (target, value) => { ReflectApply(SetAdd, target, [value]) }
  const setDelete = (target, value) => { ReflectApply(SetDelete, target, [value]) }
  const setHas = (target, value) => ReflectApply(SetHas, target, [value])
  const mapDelete = (target, key) => { ReflectApply(MapDelete, target, [key]) }
  const mapGet = (target, key) => ReflectApply(MapGet, target, [key])
  const mapSet = (target, key, value) => { ReflectApply(MapSet, target, [key, value]) }
  const plainObject = value => {
    const prototype = ObjectGetPrototypeOf(value)
    return prototype === null || prototype === ObjectPrototype
  }
  const ownEnumerableStringKeys = value => {
    const keys = ReflectOwnKeys(value)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (typeof key !== 'string' || !ReflectApply(ObjectPropertyIsEnumerable, value, [key])) return undefined
    }
    return keys
  }
  const assign = (destination, value) => {
    if (destination.kind === 'root') destination.holder.value = value
    else define(destination.target, destination.key, value)
  }
  const snapshot = input => {
    const active = new SetCtor()
    const holder = ObjectCreate(null)
    const tasks = [{ kind: 'visit', value: input, destination: { kind: 'root', holder } }]
    while (tasks.length) {
      const task = pop(tasks)
      if (task.kind === 'leave') { setDelete(active, task.source); continue }
      const candidate = task.value
      if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') {
        assign(task.destination, candidate); continue
      }
      if (typeof candidate === 'number') {
        if (!NumberIsFinite(candidate) || ObjectIs(candidate, -0)) return undefined
        assign(task.destination, candidate); continue
      }
      if (typeof candidate !== 'object' || setHas(active, candidate)) return undefined
      if (ArrayIsArray(candidate)) {
        if (ObjectGetPrototypeOf(candidate) !== ArrayPrototype || ReflectOwnKeys(candidate).length !== candidate.length + 1) return undefined
        const target = []
        assign(task.destination, target)
        setAdd(active, candidate)
        append(tasks, { kind: 'leave', source: candidate })
        for (let index = candidate.length - 1; index >= 0; index--) {
          if (!ObjectHasOwn(candidate, index)) return undefined
          append(tasks, { kind: 'visit', value: candidate[index], destination: { kind: 'slot', target, key: index } })
        }
        continue
      }
      if (!plainObject(candidate)) return undefined
      const keys = ownEnumerableStringKeys(candidate)
      if (!keys) return undefined
      const target = {}
      assign(task.destination, target)
      setAdd(active, candidate)
      append(tasks, { kind: 'leave', source: candidate })
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]
        append(tasks, { kind: 'visit', value: candidate[key], destination: { kind: 'slot', target, key } })
      }
    }
    return holder.value
  }
  const encodeWire = value => {
    const wire = []
    const pending = [value]
    while (pending.length) {
      const current = pop(pending)
      if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') {
        append(wire, current); continue
      }
      if (ArrayIsArray(current)) {
        append(wire, { kind: 'array', length: current.length })
        for (let index = current.length - 1; index >= 0; index--) append(pending, current[index])
      } else {
        const keys = ObjectKeys(current)
        append(wire, { kind: 'object', keys })
        for (let index = keys.length - 1; index >= 0; index--) append(pending, current[keys[index]])
      }
    }
    return wire
  }
  const decodeWire = wire => {
    if (!ArrayIsArray(wire) || wire.length === 0) return undefined
    const frames = []
    let root
    let assigned = false
    const attach = value => {
      const parent = frames[frames.length - 1]
      if (!parent) {
        if (assigned) return false
        root = value; assigned = true; return true
      }
      if (parent.kind === 'array') append(parent.target, value)
      else define(parent.target, parent.keys[parent.index], value)
      parent.index += 1
      return true
    }
    for (let tokenIndex = 0; tokenIndex < wire.length; tokenIndex++) {
      const token = wire[tokenIndex]
      let value
      let frame
      if (token === null || typeof token === 'boolean' || typeof token === 'string') value = token
      else if (typeof token === 'number') {
        if (!NumberIsFinite(token) || ObjectIs(token, -0)) return undefined
        value = token
      } else {
        if (!plainObject(token)) return undefined
        const keys = ownEnumerableStringKeys(token)
        if (!keys || keys.length !== 2 || keys[0] !== 'kind') return undefined
        if (token.kind === 'array' && keys[1] === 'length' && NumberIsSafeInteger(token.length) && token.length >= 0) {
          value = []
          if (token.length > wire.length - tokenIndex - 1) return undefined
          if (token.length) frame = { kind: 'array', target: value, length: token.length, index: 0 }
        } else if (token.kind === 'object' && keys[1] === 'keys' && ArrayIsArray(token.keys)) {
          const unique = new SetCtor()
          const objectKeys = []
          for (const key of token.keys) {
            if (typeof key !== 'string' || setHas(unique, key)) return undefined
            setAdd(unique, key); append(objectKeys, key)
          }
          if (objectKeys.length > wire.length - tokenIndex - 1) return undefined
          value = {}
          if (objectKeys.length) frame = { kind: 'object', target: value, keys: objectKeys, index: 0 }
        } else return undefined
      }
      if (!attach(value)) return undefined
      if (frame) append(frames, frame)
      while (frames.length) {
        const current = frames[frames.length - 1]
        const length = current.kind === 'array' ? current.length : current.keys.length
        if (current.index < length) break
        pop(frames)
      }
    }
    return frames.length === 0 ? root : undefined
  }
  const byteLength = text => ReflectApply(BufferByteLength, Buffer, [text])
  const jsonStringBytes = text => byteLength(JSONStringify(text))
  const jsonValueBytes = value => {
    let bytes = 0
    const tasks = [{ kind: 'value', value }]
    while (tasks.length) {
      const task = pop(tasks)
      if (task.kind === 'separator') { bytes += 1; continue }
      if (task.kind === 'key') { bytes += jsonStringBytes(task.value) + 1; continue }
      const current = task.value
      if (current === null) bytes += 4
      else if (typeof current === 'string') bytes += jsonStringBytes(current)
      else if (typeof current === 'number' || typeof current === 'boolean') bytes += byteLength(StringValue(current))
      else if (ArrayIsArray(current)) {
        bytes += 2
        for (let index = current.length - 1; index >= 0; index--) {
          append(tasks, { kind: 'value', value: current[index] })
          if (index > 0) append(tasks, { kind: 'separator' })
        }
      } else {
        bytes += 2
        const keys = ObjectKeys(current)
        for (let index = keys.length - 1; index >= 0; index--) {
          const key = keys[index]
          append(tasks, { kind: 'value', value: current[key] })
          append(tasks, { kind: 'key', value: key })
          if (index > 0) append(tasks, { kind: 'separator' })
        }
      }
    }
    return bytes
  }
  const truncate = (text, available) => {
    if (available < 2) return ''
    let result = ''
    let bytes = 2
    let index = 0
    while (index < text.length) {
      const first = ReflectApply(StringCharCodeAt, text, [index])
      let end = index + 1
      if (first >= 0xd800 && first <= 0xdbff && end < text.length) {
        const second = ReflectApply(StringCharCodeAt, text, [end])
        if (second >= 0xdc00 && second <= 0xdfff) end += 1
      }
      const character = ReflectApply(StringSlice, text, [index, end])
      const cost = jsonStringBytes(character) - 2
      if (bytes + cost > available) break
      bytes += cost
      result += character
      index = end
    }
    return result
  }
  let logBytes = 2
  let logEntries = 0
  let limited = false
  const pushLog = text => {
    if (limited) return
    const separator = logEntries > 0 ? 1 : 0
    const available = workerData.maxOutputBytes - logBytes - separator
    const cost = jsonStringBytes(text)
    if (cost > available) {
      const prefix = truncate(text, available)
      if (prefix) {
        logBytes += jsonStringBytes(prefix) + separator
        logEntries += 1
        port.postMessage({ type: 'log', text: prefix })
      }
      limited = true
      port.postMessage({ type: 'output-limit' })
      return
    }
    logBytes += cost + separator
    logEntries += 1
    port.postMessage({ type: 'log', text })
  }
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  process.stdout.write = (chunk, ...rest) => {
    pushLog(typeof chunk === 'string' ? chunk : StringValue(chunk))
    let callback
    for (let index = 0; index < rest.length; index++) {
      if (typeof rest[index] === 'function') { callback = rest[index]; break }
    }
    if (callback) QueueMicrotask(() => { callback(null) })
    return true
  }
  process.stderr.write = process.stdout.write
  const consoleShim = ObjectCreate(null)
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    define(consoleShim, level, (...args) => {
      const rendered = []
      for (let index = 0; index < args.length; index++) {
        const value = args[index]
        append(rendered, typeof value === 'string' ? value : inspect(value, { depth: 4, maxArrayLength: 100, maxStringLength: 10000 }))
      }
      pushLog(ReflectApply(ArrayJoin, rendered, [' ']))
    })
  }
  const pending = new Map()
  let nextId = 1
  const errorClasses = new Map()
  for (const namespace of workerData.namespaces) {
    if (!namespace.errorClass) continue
    const descriptor = namespace.errorClass
    mapSet(errorClasses, namespace.global, class BindingCallError extends CapturedError {
      constructor(memberName, message) {
        super(message)
        ObjectDefineProperty(this, 'name', { value: descriptor.name, enumerable: true })
        ObjectDefineProperty(this, descriptor.memberNameProperty, { value: memberName, enumerable: true })
      }
    })
  }
  port.on('message', message => {
    if (!message || message.type !== 'reply' || typeof message.id !== 'number') return
    const entry = mapGet(pending, message.id)
    if (!entry) return
    mapDelete(pending, message.id)
    if (!message.ok) { entry.reject(new CapturedError(StringValue(message.message))); return }
    const value = decodeWire(message.value)
    if (value === undefined) entry.reject(new CapturedError('binding resolution must be lossless JSON'))
    else entry.resolve(value)
  })
  const namespaces = workerData.namespaces.map(namespace => {
    const target = ObjectCreate(null)
    const ErrorClass = mapGet(errorClasses, namespace.global)
    for (const name of namespace.names) {
      define(target, name, args => {
        const detached = snapshot(args)
        if (detached === undefined) {
          return ReflectApply(PromiseReject, PromiseCtor, [ErrorClass ? new ErrorClass(name, 'binding arguments must be lossless JSON') : new CapturedError('binding arguments must be lossless JSON')])
        }
        return new PromiseCtor((resolve, reject) => {
          const id = nextId++
          mapSet(pending, id, {
            resolve,
            reject: error => { reject(ErrorClass ? new ErrorClass(name, error.message) : error) },
          })
          port.postMessage({ type: 'call', id, global: namespace.global, name, args: encodeWire(detached) })
        })
      })
    }
    return target
  })
  const errorClassNames = []
  const errorClassValues = []
  for (const namespace of workerData.namespaces) {
    if (!namespace.errorClass) continue
    append(errorClassNames, namespace.errorClass.name)
    append(errorClassValues, mapGet(errorClasses, namespace.global))
  }
  const AsyncFunction = ObjectGetPrototypeOf(async function () {}).constructor
  try {
    const fn = new AsyncFunction(...workerData.namespaces.map(value => value.global), ...errorClassNames, 'console', '"use strict";\n' + workerData.code)
    const value = await fn(...namespaces, ...errorClassValues, consoleShim)
    if (!limited) {
      if (value === undefined) port.postMessage({ type: 'done' })
      else {
        const detached = snapshot(value)
        if (detached === undefined) {
          const message = 'program completion must be lossless JSON'
          if (jsonStringBytes(message) > workerData.maxOutputBytes - logBytes) port.postMessage({ type: 'output-limit' })
          else port.postMessage({ type: 'done', error: { kind: 'invalid-output', message } })
        } else if (jsonValueBytes(detached) > workerData.maxOutputBytes - logBytes) {
          port.postMessage({ type: 'output-limit' })
        } else {
          port.postMessage({ type: 'done', value: encodeWire(detached) })
        }
      }
    }
  } catch (error) {
    if (!limited) {
      let message
      try { message = error instanceof CapturedError ? error.stack || error.message : StringValue(error) }
      catch { message = 'program threw an unrenderable value' }
      if (jsonStringBytes(message) > workerData.maxOutputBytes - logBytes) port.postMessage({ type: 'output-limit' })
      else port.postMessage({ type: 'done', error: { kind: 'exception', message } })
    }
  } finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
} else if (process.env.DSH_CODE_RUNTIME_CONTROLLER === '1') {
  runController()
} else {
  runLauncher()
}
`
