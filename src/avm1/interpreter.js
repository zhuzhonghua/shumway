/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil; tab-width: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/*
 * Copyright 2013 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*global avm1lib, Proxy, Multiname, ActionsDataStream, TelemetryService,
         isNumeric, forEachPublicProperty, construct */

var AVM1_TRACE_ENABLED = false;
var AVM1_ERRORS_IGNORED = true;
var MAX_AVM1_HANG_TIMEOUT = 1000;
var MAX_AVM1_ERRORS_LIMIT = 1000;
var MAX_AVM1_STACK_LIMIT = 256;

function AS2ScopeListItem(scope, next) {
  this.scope = scope;
  this.next = next;
}
AS2ScopeListItem.prototype = {
  create: function (scope) {
    return new AS2ScopeListItem(scope, this);
  }
};

function AS2Context(swfVersion) {
  this.swfVersion = swfVersion;
  this.globals = new avm1lib.AS2Globals(this);
  this.initialScope = new AS2ScopeListItem(this.globals, null);
  this.assets = {};
  this.isActive = false;
  this.executionProhibited = false;
  this.abortExecutionAt = 0;
  this.stackDepth = 0;
  this.isTryCatchListening = false;
  this.errorsIgnored = 0;
  this.deferScriptExecution = true;
  this.pendingScripts = [];
}
AS2Context.instance = null;
AS2Context.prototype = {
  addAsset: function(className, symbolProps) {
    this.assets[className] = symbolProps;
  },
  resolveTarget: function(target) {
    if (!target) {
      target = this.defaultTarget;
    } else if (typeof target === 'string') {
      target = lookupAS2Children(target, this.defaultTarget,
                                 this.globals.asGetPublicProperty('_root'));
    }
    if (typeof target !== 'object' || target === null ||
        !('$nativeObject' in target)) {
      throw new Error('Invalid AS2 target object: ' +
                      Object.prototype.toString.call(target));
    }

    return target;
  },
  resolveLevel: function(level) {
    return this.resolveTarget(this.globals['_level' + level]);
  },
  addToPendingScripts: function (fn) {
    if (!this.deferScriptExecution) {
      return fn();
    }
    this.pendingScripts.push(fn);
  },
  flushPendingScripts: function () {
    var scripts = this.pendingScripts;
    while (scripts.length) {
      scripts.shift()();
    }
    this.deferScriptExecution = false;
  }
};

function AS2Error(error) {
  this.error = error;
}

function AS2CriticalError(message, error) {
  this.message = message;
  this.error = error;
}
AS2CriticalError.prototype = Object.create(Error.prototype);

function isAS2MovieClip(obj) {
  return typeof obj === 'object' && obj &&
         obj instanceof avm1lib.AS2MovieClip;
}

function as2GetType(v) {
  if (v === null) {
    return 'null';
  }

  var type = typeof v;
  if (type === 'function') {
    return 'object';
  }
  if (type === 'object' && isAS2MovieClip(v)) {
    return 'movieclip';
  }
  return type;
}

function as2ToPrimitive(value) {
  return as2GetType(value) !== 'object' ? value : value.valueOf();
}

function as2ToAddPrimitive(value) {
  if (as2GetType(value) !== 'object') {
    return value;
  }

  if (value instanceof Date && AS2Context.instance.swfVersion >= 6) {
    return value.toString();
  } else {
    return value.valueOf();
  }
}

function as2ToBoolean(value) {
  switch (as2GetType(value)) {
  default:
  case 'undefined':
  case 'null':
    return false;
  case 'boolean':
    return value;
  case 'number':
    return value !== 0 && !isNaN(value);
  case 'string':
    return value.length !== 0;
  case 'movieclip':
  case 'object':
    return true;
  }
}

function as2ToNumber(value) {
  value = as2ToPrimitive(value);
  switch (as2GetType(value)) {
  case 'undefined':
  case 'null':
    return AS2Context.instance.swfVersion >= 7 ? NaN : 0;
  case 'boolean':
    return value ? 1 : +0;
  case 'number':
    return value;
  case 'string':
    if (value === '' && AS2Context.instance.swfVersion < 5) {
      return 0;
    }
    return +value;
  default:
    return AS2Context.instance.swfVersion >= 5 ? NaN : 0;
  }
}

function as2ToInteger(value) {
  var result = as2ToNumber(value);
  if (isNaN(result)) {
    return 0;
  }
  if (!isFinite(result) || result === 0) {
    return result;
  }
  return (result < 0 ? -1 : 1) * Math.abs(result)|0;
}

function as2ToInt32(value) {
  var result = as2ToNumber(value);
  return (isNaN(result) || !isFinite(result) || result === 0) ? 0 :
    (result | 0);
}

// TODO: We should just override Function.prototype.toString and change this to
// only have a special case for 'undefined'.
function as2ToString(value) {
  switch (as2GetType(value)) {
  case 'undefined':
    return AS2Context.instance.swfVersion >= 7 ? 'undefined' : '';
  case 'null':
    return 'null';
  case 'boolean':
    return value ? 'true' : 'false';
  case 'number':
    return value.toString();
  case 'string':
    return value;
  case 'movieclip':
    return value.$targetPath;
  case 'object':
    var result = value.toString !== Function.prototype.toString ?
      value.toString() : value;
    if (typeof result === 'string') {
      return result;
    }
    return typeof value === 'function' ? '[type Function]'
                                       : '[type Object]';
  }
}

function as2Compare(x, y) {
  var x2 = as2ToPrimitive(x);
  var y2 = as2ToPrimitive(y);
  if (typeof x2 === 'string' && typeof y2 === 'string') {
    return x2 < y2;
  } else {
    return as2ToNumber(x2) < as2ToNumber(y2);
  }
}

function as2InstanceOf(obj, constructor) {
  if (obj instanceof constructor) {
    return true;
  }
  // TODO interface check
  return false;
}

function as2ResolveProperty(obj, name) {
  // checking if avm2 public property is present
  var avm2PublicName = Multiname.getPublicQualifiedName(name);
  if (avm2PublicName in obj) {
    return name;
  }
  if (isNumeric(name)) {
    return null;
  }
  var lowerCaseName = avm2PublicName.toLowerCase();
  for (var i in obj) {
    if (i.toLowerCase() === lowerCaseName) {
      return i.substr(Multiname.PUBLIC_QUALIFIED_NAME_PREFIX.length);
    }
  }
  return null;
}

function as2GetPrototype(obj) {
  return obj && obj.asGetPublicProperty('prototype');
}

function isAvm2Class(obj) {
  return typeof obj === 'object' && obj !== null && 'instanceConstructor' in obj;
}

function as2CreatePrototypeProxy(obj) {
  var prototype = obj.asGetPublicProperty('prototype');
  if (typeof Proxy === 'undefined') {
    console.error('ES6 proxies are not found');
    return prototype;
  }
  return Proxy.create({
    getOwnPropertyDescriptor: function(name) {
      return Object.getOwnPropertyDescriptor(prototype, name);
    },
    getPropertyDescriptor:  function(name) {
      // ES6: return getPropertyDescriptor(prototype, name);
      for (var p = prototype; p; p = Object.getPrototypeOf(p)) {
        var desc = Object.getOwnPropertyDescriptor(p, name);
        if (desc) return desc;
      }
    },
    getOwnPropertyNames: function() {
      return Object.getOwnPropertyNames(prototype);
    },
    getPropertyNames: function() {
      // ES6: return getPropertyNames(prototype, name);
      var names = Object.getOwnPropertyNames(prototype);
      for (var p = Object.getPrototypeOf(prototype); p;
           p = Object.getPrototypeOf(p)) {
        names = names.concat(Object.getOwnPropertyNames(p));
      }
      return names;
    },
    defineProperty: function(name, desc) {
      if (desc) {
        if (typeof desc.value === 'function' && desc.value._setClass) {
          desc.value._setClass(obj);
        }
        if (typeof desc.get === 'function' && desc.get._setClass) {
          desc.get._setClass(obj);
        }
        if (typeof desc.set === 'function' && desc.set._setClass) {
          desc.set._setClass(obj);
        }
      }
      return Object.defineProperty(prototype, name, desc);
    },
    delete: function(name) {
      return delete prototype[name];
    },
    fix: function() {
      return undefined;
    }
  });
}

function executeActions(actionsData, context, scope) {
  if (context.executionProhibited) {
    return; // no more avm1 for this context
  }

  var actionTracer = ActionTracerFactory.get();

  var scopeContainer = context.initialScope.create(scope);
  var savedContext = AS2Context.instance;
  try {
    AS2Context.instance = context;
    context.isActive = true;
    context.abortExecutionAt = Date.now() + MAX_AVM1_HANG_TIMEOUT;
    context.errorsIgnored = 0;
    context.defaultTarget = scope;
    context.globals.asSetPublicProperty('this', scope);
    actionTracer.message('ActionScript Execution Starts');
    actionTracer.indent();
    interpretActions(actionsData, scopeContainer, null, []);
  } catch (e) {
    if (e instanceof AS2CriticalError) {
      console.error('Disabling AVM1 execution');
      context.executionProhibited = true;
    }
    throw e; // TODO shall we just ignore it?
  } finally {
    context.isActive = false;
    actionTracer.unindent();
    actionTracer.message('ActionScript Execution Stops');
    AS2Context.instance = savedContext;
  }
}

function lookupAS2Children(targetPath, defaultTarget, root) {
  var path = targetPath.split(/[\/.]/g);
  if (path[path.length - 1] === '') {
    path.pop();
  }
  var obj = defaultTarget;
  if (path[0] === '' || path[0] === '_level0' || path[0] === '_root') {
    obj = root;
    path.shift();
  }
  while (path.length > 0) {
    var prevObj = obj;
    obj = obj.$lookupChild(path[0]);
    if (!obj) {
      throw new Error(path[0] + ' (expr ' + targetPath + ') is not found in ' +
                      prevObj._target);
    }
    path.shift();
  }
  return obj;
}

function createBuiltinType(obj, args) {
  if (obj === Array) {
    // special case of array
    var result = args;
    if (args.length == 1 && typeof args[0] === 'number') {
      result = [];
      result.length = args[0];
    }
    return result;
  }
  if (obj === Boolean || obj === Number || obj === String || obj === Function) {
    return obj.apply(null, args);
  }
  if (obj === Date) {
    switch (args.length) {
      case 0:
        return new Date();
      case 1:
        return new Date(args[0]);
      default:
        return new Date(args[0], args[1],
          args.length > 2 ? args[2] : 1,
          args.length > 3 ? args[3] : 0,
          args.length > 4 ? args[4] : 0,
          args.length > 5 ? args[5] : 0,
          args.length > 6 ? args[6] : 0);
    }
  }
  if (obj === Object) {
    return {};
  }
}

var AS2_SUPER_STUB = {};

function interpretActions(actionsData, scopeContainer,
                          constantPool, registers) {
  var currentContext = AS2Context.instance;

  function setTarget(targetPath) {
    if (!targetPath) {
      currentContext.defaultTarget = scope;
      return;
    }

    try {
      currentContext.defaultTarget =
        lookupAS2Children(targetPath, defaultTarget, _global.asGetPublicProperty('_root'));
    } catch (e) {
      currentContext.defaultTarget = null;
      throw e;
    }
  }

  function defineFunction(functionName, parametersNames,
                          registersAllocation, actionsData) {
    var ownerClass;
    var fn = (function() {
      var newScope = {};
      newScope.asSetPublicProperty('this', this);
      newScope.asSetPublicProperty('arguments', arguments);
      newScope.asSetPublicProperty('super', AS2_SUPER_STUB);
      newScope.asSetPublicProperty('__class', ownerClass);
      var newScopeContainer = scopeContainer.create(newScope);
      var i;
      for (i = 0; i < arguments.length || i < parametersNames.length; i++) {
        newScope.asSetPublicProperty(parametersNames[i], arguments[i]);
      }
      var registers = [];
      if (registersAllocation) {
        for (i = 0; i < registersAllocation.length; i++) {
          var registerAllocation = registersAllocation[i];
          if (!registerAllocation) {
            continue;
          }
          if (registerAllocation.type == 'param') {
            registers[i] = arguments[registerAllocation.index];
          } else { // var
            switch (registerAllocation.name) {
              case 'this':
                registers[i] = this;
                break;
              case 'arguments':
                registers[i] = arguments;
                break;
              case 'super':
                registers[i] = AS2_SUPER_STUB;
                break;
              case '_global':
                registers[i] = _global;
                break;
              case '_parent':
                registers[i] = scope.asGetPublicProperty('_parent');
                break;
              case '_root':
                registers[i] = _global.asGetPublicProperty('_root');
                break;
            }
          }
        }
      }

      var savedContext = AS2Context.instance;
      var savedIsActive = currentContext.isActive;
      try
      {
        // switching contexts if called outside main thread
        AS2Context.instance = currentContext;
        if (!savedIsActive) {
          currentContext.abortExecutionAt = Date.now() + MAX_AVM1_HANG_TIMEOUT;
          currentContext.errorsIgnored = 0;
          currentContext.isActive = true;
        }
        currentContext.defaultTarget = scope;
        actionTracer.indent();
        currentContext.stackDepth++;
        if (currentContext.stackDepth >= MAX_AVM1_STACK_LIMIT) {
          throw new AS2CriticalError('long running script -- AVM1 recursion limit is reached');
        }
        return interpretActions(actionsData, newScopeContainer,
          constantPool, registers);
      } finally {
        currentContext.isActive = savedIsActive;
        currentContext.stackDepth--;
        actionTracer.unindent();
        currentContext.defaultTarget = defaultTarget;
        AS2Context.instance = savedContext;
      }
    });

    ownerClass = fn;
    fn._setClass = function (class_) {
      ownerClass = class_;
    };

    fn.instanceConstructor = fn;
    fn.debugName = 'avm1 ' + (functionName || '<function>');
    if (functionName) {
      fn.name = functionName;
    }
    return fn;
  }
  function deleteProperty(propertyName) {
    for (var p = scopeContainer; p; p = p.next) {
      if (p.scope.asHasProperty(undefined, propertyName, 0)) {
        p.scope.asSetPublicProperty(propertyName, undefined); // in some cases we need to cleanup events binding
        return p.scope.asDeleteProperty(undefined, propertyName, 0);
      }
    }
    return false;
  }
  function resolveVariableName(variableName, nonStrict) {
    var obj, name, i;
    if (variableName.indexOf(':') >= 0) {
      // "/A/B:FOO references the FOO variable in the movie clip with a target path of /A/B."
      var parts = variableName.split(':');
      obj = lookupAS2Children(parts[0], defaultTarget,
                              _global.asGetPublicProperty('_root'));
      if (!obj) {
        throw new Error(parts[0] + ' is undefined');
      }
      name = parts[1];
    } else if (variableName.indexOf('.') >= 0) {
      // new object reference
      var objPath = variableName.split('.');
      name = objPath.pop();
      obj = _global;
      for (i = 0; i < objPath.length; i++) {
        obj = obj.asGetPublicProperty(objPath[i]) || obj[objPath[i]];
        if (!obj) {
          throw new Error(objPath.slice(0, i + 1) + ' is undefined');
        }
      }
    }

    if (!obj) {
      return null; // local variable
    }

    var resolvedName = as2ResolveProperty(obj, name);
    var resolved = resolvedName !== null;
    if (resolved || nonStrict) {
      return { obj: obj, name: resolvedName || name, resolved: resolved };
    }

    return null;
  }
  function getThis() {
    var _this = scope.asGetPublicProperty('this');
    if (_this) {
      return _this;
    }
    for (var p = scopeContainer; p; p = p.next) {
      resolvedName = as2ResolveProperty(p.scope, 'this');
      if (resolvedName !== null) {
        return p.scope.asGetPublicProperty(resolvedName);
      }
    }
  }
  function getVariable(variableName) {
    // fast check if variable in the current scope
    if (scope.asHasProperty(undefined, variableName, 0)) {
      return scope.asGetPublicProperty(variableName);
    }

    var target = resolveVariableName(variableName);
    if (target) {
      return target.obj.asGetPublicProperty(target.name);
    }
    var resolvedName, _this = getThis();
    for (var p = scopeContainer; p; p = p.next) {
      resolvedName = as2ResolveProperty(p.scope, variableName);
      if (resolvedName !== null) {
        return p.scope.asGetPublicProperty(resolvedName);
      }
    }
    if(_this && (resolvedName = as2ResolveProperty(_this, variableName))) {
      return _this.asGetPublicProperty(resolvedName);
    }
    // trying movie clip children (if object is a MovieClip)
    var mc = isAS2MovieClip(defaultTarget) &&
             defaultTarget.$lookupChild(variableName);
    if (mc) {
      return mc;
    }
  }

  function setVariable(variableName, value) {
    // fast check if variable in the current scope
    if (scope.asHasProperty(undefined, variableName, 0)) {
      scope.asSetPublicProperty(variableName, value);
      return;
    }

    var target = resolveVariableName(variableName, true);
    if (target) {
      target.obj.asSetPublicProperty(target.name, value);
      return;
    }
    var resolvedName, _this = getThis();
    if(_this && (resolvedName = as2ResolveProperty(_this, variableName))) {
      return _this.asSetPublicProperty(resolvedName, value);
    }

    for (var p = scopeContainer; p.next; p = p.next) { // excluding globals
      resolvedName = as2ResolveProperty(p.scope, variableName);
      if (resolvedName !== null) {
        return p.scope.asSetPublicProperty(resolvedName, value);
      }
    }
    (_this || scope).asSetPublicProperty(variableName, value);
  }
  function getFunction(functionName) {
    var fn = getVariable(functionName);
    if (!(fn instanceof Function)) {
      throw new Error('Function "' + functionName + '" is not found');
    }
    return fn;
  }
  function getObjectByName(objectName) {
    var obj = getVariable(objectName);
    if (!(obj instanceof Object)) {
      throw new Error('Object "' + objectName + '" is not found');
    }
    return obj;
  }
  function processWith(obj, withBlock) {
    var newScopeContainer = scopeContainer.create(Object(obj));
    interpretActions(withBlock, newScopeContainer, constantPool, registers);
  }
  function processTry(catchIsRegisterFlag, finallyBlockFlag, catchBlockFlag, catchTarget,
                      tryBlock, catchBlock, finallyBlock) {

    var savedTryCatchState = currentContext.isTryCatchListening;
    try {
      currentContext.isTryCatchListening = true;
      interpretActions(tryBlock, scopeContainer, constantPool, registers);
    } catch (e) {
      currentContext.isTryCatchListening = savedTryCatchState;
      if (!catchBlockFlag) {
        throw e;
      }
      if (!(e instanceof AS2Error)) {
        throw e;
      }
      if (typeof catchTarget === 'string') {
        scope[catchTarget] = e.error;
      } else {
        registers[catchTarget] = e.error;
      }
      interpretActions(catchBlock, scopeContainer, constantPool, registers);
    } finally {
      currentContext.isTryCatchListening = savedTryCatchState;
      if (finallyBlockFlag) {
        interpretActions(finallyBlock, scopeContainer, constantPool, registers);
      }
    }
  }
  function validateArgsCount(numArgs, maxAmount) {
    if (isNaN(numArgs) || numArgs < 0 || numArgs > maxAmount ||
        numArgs != (0|numArgs)) {
      throw new Error('Invalid number of arguments: ' + numArgs);
    }
  }
  function readArgs(stack) {
    var numArgs = +stack.pop();
    validateArgsCount(numArgs, stack.length);
    var args = [];
    for (var i = 0; i < numArgs; i++) {
      args.push(stack.pop());
    }
    return args;
  }

  var stream = new ActionsDataStream(actionsData, currentContext.swfVersion);
  var _global = currentContext.globals;
  var defaultTarget = currentContext.defaultTarget;
  var stack = [];
  var scope = scopeContainer.scope;
  var isSwfVersion5 = currentContext.swfVersion >= 5;
  var actionTracer = ActionTracerFactory.get();
  var nextPosition;

  if (scope.$nativeObject && scope.$nativeObject._deferScriptExecution) {
    currentContext.deferScriptExecution = true;
  }

  function skipActions(count) {
    while (count > 0 && stream.position < stream.end) {
      var actionCode = stream.readUI8();
      var length = actionCode >= 0x80 ? stream.readUI16() : 0;
      stream.position += length;
      count--;
    }
    nextPosition = stream.position;
  }

  var recoveringFromError = false;
  var stackItemsExpected;
  // will try again if we are skipping errors
  while (stream.position < stream.end) {
    try {

  var instructionsExecuted = 0;
  var abortExecutionAt = currentContext.abortExecutionAt;
  while (stream.position < stream.end) {
    // let's check timeout every 100 instructions
    if (instructionsExecuted++ % 100 === 0 && Date.now() >= abortExecutionAt) {
      throw new AS2CriticalError('long running script -- AVM1 instruction hang timeout');
    }

    var actionCode = stream.readUI8();
    var length = actionCode >= 0x80 ? stream.readUI16() : 0;
    nextPosition = stream.position + length;
    stackItemsExpected = 0;

    actionTracer.print(stream.position, actionCode, stack);
    var frame, type, count, index, target, method, constr, codeSize, offset;
    var name, variableName, methodName, functionName, targetName;
    var paramName, resolvedName, objectName;
    var value, a, b, c, f, sa, sb, obj, args, fn, result, flags, i;
    var dragParams, register;
    switch (actionCode | 0) {
      // SWF 3 actions
      case 0x81: // ActionGotoFrame
        frame = stream.readUI16();
        var nextActionCode = stream.readUI8();
        nextPosition++;
        methodName = nextActionCode === 0x06 ? 'gotoAndPlay' : 'gotoAndStop';
        _global[methodName](frame + 1);
        break;
      case 0x83: // ActionGetURL
        var urlString = stream.readString();
        var targetString = stream.readString();
        _global.getURL(urlString, targetString);
        break;
      case 0x04: // ActionNextFrame
        _global.nextFrame();
        break;
      case 0x05: // ActionPreviousFrame
        _global.prevFrame();
        break;
      case 0x06: // ActionPlay
        _global.play();
        break;
      case 0x07: // ActionStop
        _global.stop();
        break;
      case 0x08: // ActionToggleQuality
        _global.toggleHighQuality();
        break;
      case 0x09: // ActionStopSounds
        _global.stopAllSounds();
        break;
      case 0x8A: // ActionWaitForFrame
        frame = stream.readUI16();
        count = stream.readUI8();
        if (!_global.ifFrameLoaded(frame)) {
          skipActions(count);
        }
        break;
      case 0x8B: // ActionSetTarget
        targetName = stream.readString();
        setTarget(targetName);
        break;
      case 0x8C: // ActionGoToLabel
        var label = stream.readString();
        _global.gotoLabel(label);
        break;
      // SWF 4 actions
      case 0x96: // ActionPush
        while (stream.position < nextPosition) {
          type = stream.readUI8();
          switch (type) {
            case 0: // STRING
              value = stream.readString();
              break;
            case 1: // FLOAT
              value = stream.readFloat();
              break;
            case 2: // null
              value = null;
              break;
            case 3: // undefined
              value = void(0);
              break;
            case 4: // Register number
              value = registers[stream.readUI8()];
              break;
            case 5: // Boolean
              value = stream.readBoolean();
              break;
            case 6: // Double
              value = stream.readDouble();
              break;
            case 7: // Integer
              value = stream.readInteger();
              break;
            case 8: // Constant8
              value = constantPool[stream.readUI8()];
              break;
            case 9: // Constant16
              value = constantPool[stream.readUI16()];
              break;
            default:
              throw new Error('Unknown value type: ' + type);
          }
          stack.push(value);
        }
        break;
      case 0x17: // ActionPop
        stack.pop();
        break;
      case 0x0A: // ActionAdd
        a = as2ToNumber(stack.pop());
        b = as2ToNumber(stack.pop());
        stack.push(a + b);
        break;
      case 0x0B: // ActionSubtract
        a = as2ToNumber(stack.pop());
        b = as2ToNumber(stack.pop());
        stack.push(b - a);
        break;
      case 0x0C: // ActionMultiply
        a = as2ToNumber(stack.pop());
        b = as2ToNumber(stack.pop());
        stack.push(a * b);
        break;
      case 0x0D: // ActionDivide
        a = as2ToNumber(stack.pop());
        b = as2ToNumber(stack.pop());
        c = b / a;
        stack.push(isSwfVersion5 ? c : isFinite(c) ? c : '#ERROR#');
        break;
      case 0x0E: // ActionEquals
        a = as2ToNumber(stack.pop());
        b = as2ToNumber(stack.pop());
        f = a == b;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x0F: // ActionLess
        a = as2ToNumber(stack.pop());
        b = as2ToNumber(stack.pop());
        f = b < a;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x10: // ActionAnd
        a = as2ToBoolean(stack.pop());
        b = as2ToBoolean(stack.pop());
        f = a && b;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x11: // ActionOr
        a = as2ToBoolean(stack.pop());
        b = as2ToBoolean(stack.pop());
        f = a || b;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x12: // ActionNot
        f = !as2ToBoolean(stack.pop());
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x13: // ActionStringEquals
        sa = as2ToString(stack.pop());
        sb = as2ToString(stack.pop());
        f = sa == sb;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x14: // ActionStringLength
      case 0x31: // ActionMBStringLength
        sa = as2ToString(stack.pop());
        stack.push(_global.length(sa));
        break;
      case 0x21: // ActionStringAdd
        sa = as2ToString(stack.pop());
        sb = as2ToString(stack.pop());
        stack.push(sb + sa);
        break;
      case 0x15: // ActionStringExtract
        count = stack.pop();
        index = stack.pop();
        value = as2ToString(stack.pop());
        stack.push(_global.substring(value, index, count));
        break;
      case 0x35: // ActionMBStringExtract
        count = stack.pop();
        index = stack.pop();
        value = as2ToString(stack.pop());
        stack.push(_global.mbsubstring(value, index, count));
        break;
      case 0x29: // ActionStringLess
        sa = as2ToString(stack.pop());
        sb = as2ToString(stack.pop());
        f = sb < sa;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x18: // ActionToInteger
        stack.push(_global.int(stack.pop()));
        break;
      case 0x32: // ActionCharToAscii
        stack.push(_global.chr(stack.pop()));
        break;
      case 0x36: // ActionMBCharToAscii
        stack.push(_global.mbchr(stack.pop()));
        break;
      case 0x33: // ActionAsciiToChar
        stack.push(_global.ord(stack.pop()));
        break;
      case 0x37: // ActionMBAsciiToChar
        stack.push(_global.mbord(stack.pop()));
        break;
      case 0x99: // ActionJump
        offset = stream.readSI16();
        nextPosition += offset;
        break;
      case 0x9D: // ActionIf
        offset = stream.readSI16();
        f = !!stack.pop();
        if (f) {
          nextPosition += offset;
        }
        break;
      case 0x9E: // ActionCall
        label = stack.pop();
        _global.call(label);
        break;
      case 0x1C: // ActionGetVariable
        variableName = '' + stack.pop();
        stackItemsExpected++;
        stack.push(getVariable(variableName));
        break;
      case 0x1D: // ActionSetVariable
        value = stack.pop();
        variableName = '' + stack.pop();
        setVariable(variableName, value);
        break;
      case 0x9A: // ActionGetURL2
        flags = stream.readUI8();
        target = stack.pop();
        var url = stack.pop();
        var sendVarsMethod;
        if (flags & 1) {
          sendVarsMethod = 'GET';
        } else if (flags & 2) {
          sendVarsMethod = 'POST';
        }
        var loadTargetFlag = flags & 1 << 6;
        if (!loadTargetFlag) {
          _global.getURL(url, target, sendVarsMethod);
          break;
        }
        var loadVariablesFlag = flags & 1 << 7;
        if (loadVariablesFlag) {
          _global.loadVariables(url, target, sendVarsMethod);
        } else {
          _global.loadMovie(url, target, sendVarsMethod);
        }
        break;
      case 0x9F: // ActionGotoFrame2
        flags = stream.readUI8();
        var gotoParams = [stack.pop()];
        if (!!(flags & 2)) {
          gotoParams.push(stream.readUI16());
        }
        var gotoMethod = !!(flags & 1) ? _global.gotoAndPlay : _global.gotoAndStop;
        gotoMethod.apply(_global, gotoParams);
        break;
      case 0x20: // ActionSetTarget2
        target = stack.pop();
        setTarget(target);
        break;
      case 0x22: // ActionGetProperty
        index = stack.pop();
        target = stack.pop();
        stackItemsExpected++;
        stack.push(_global.getAS2Property(target, index));
        break;
      case 0x23: // ActionSetProperty
        value = stack.pop();
        index = stack.pop();
        target = stack.pop();
        _global.setAS2Property(target, index, value);
        break;
      case 0x24: // ActionCloneSprite
        var depth = stack.pop();
        target = stack.pop();
        var source = stack.pop();
        _global.duplicateMovieClip(source, target, depth);
        break;
      case 0x25: // ActionRemoveSprite
        target = stack.pop();
        _global.removeMovieClip(target);
        break;
      case 0x27: // ActionStartDrag
        target = stack.pop();
        var lockcenter = stack.pop();
        var constrain = !stack.pop() ? null : {
          y2: stack.pop(),
          x2: stack.pop(),
          y1: stack.pop(),
          x1: stack.pop()
        };
        dragParams = [target, lockcenter];
        if (constrain) {
          dragParams = dragParams.push(constrain.x1, constrain.y1,
            constrain.x2, constrain.y2);
        }
        _global.startDrag.apply(_global, dragParams);
        break;
      case 0x28: // ActionEndDrag
        _global.stopDrag();
        break;
      case 0x8D: // ActionWaitForFrame2
        count = stream.readUI8();
        frame = stack.pop();
        if (!_global.ifFrameLoaded(frame)) {
          skipActions(count);
        }
        break;
      case 0x26: // ActionTrace
        value = stack.pop();
        _global.trace(value);
        break;
      case 0x34: // ActionGetTime
        stack.push(_global.getTimer());
        break;
      case 0x30: // ActionRandomNumber
        stack.push(_global.random(stack.pop()));
        break;
      // SWF 5
      case 0x3D: // ActionCallFunction
        functionName = stack.pop();
        args = readArgs(stack);
        stackItemsExpected++;
        fn = getFunction(functionName);
        result = fn.apply(scope, args);
        stack.push(result);
        break;
      case 0x52: // ActionCallMethod
        methodName = stack.pop();
        obj = stack.pop();
        args = readArgs(stack);
        stackItemsExpected++;
        // checking "if the method name is blank or undefined"
        if (methodName !== null && methodName !== undefined &&
            methodName !== '') {
          if (obj === null || obj === undefined) {
            throw new Error('Cannot call method ' + methodName + ' of ' + typeof obj);
          } else if (obj !== AS2_SUPER_STUB) {
            target = Object(obj);
          } else {
            target = as2GetPrototype(getVariable('__class').__super);
            obj = getVariable('this');
          }
          resolvedName = as2ResolveProperty(target, methodName);
          if (resolvedName === null) {
            throw new Error('Method ' + methodName + ' is not defined.');
          }
          result = target.asGetPublicProperty(resolvedName).apply(obj, args);
        } else if (obj !== AS2_SUPER_STUB) {
          result = obj.apply(obj, args);
        } else {
          result = getVariable('__class').__super.apply(
            getVariable('this'), args);
        }
        stack.push(result);
        break;
      case 0x88: // ActionConstantPool
        count = stream.readUI16();
        constantPool = [];
        for (i = 0; i < count; i++) {
          constantPool.push(stream.readString());
        }
        break;
      case 0x9B: // ActionDefineFunction
        functionName = stream.readString();
        count = stream.readUI16();
        args = [];
        for (i = 0; i < count; i++) {
          args.push(stream.readString());
        }
        codeSize = stream.readUI16();
        nextPosition += codeSize;

        fn = defineFunction(functionName, args, null,
                            stream.readBytes(codeSize));
        if (functionName) {
          scope.asSetPublicProperty(functionName, fn);
        } else {
          stack.push(fn);
        }
        break;
      case 0x3C: // ActionDefineLocal
        value = stack.pop();
        name = stack.pop();
        scope.asSetPublicProperty(name, value);
        break;
      case 0x41: // ActionDefineLocal2
        name = stack.pop();
        scope.asSetPublicProperty(name, undefined);
        break;
      case 0x3A: // ActionDelete
        name = stack.pop();
        obj = stack.pop();
         // in some cases we need to cleanup events binding
        obj.asSetPublicProperty(name, undefined);
        stack.push(obj.asDeleteProperty(undefined, name, 0));
        break;
      case 0x3B: // ActionDelete2
        name = stack.pop();
        result = deleteProperty(name);
        stack.push(result);
        break;
      case 0x46: // ActionEnumerate
        objectName = stack.pop();
        stack.push(null);
        obj = getObjectByName(objectName);
        /*jshint -W083 */
        forEachPublicProperty(obj, function (name) {
          stack.push(name);
        });
        break;
      case 0x49: // ActionEquals2
        a = stack.pop();
        b = stack.pop();
        stack.push(a == b);
        break;
      case 0x4E: // ActionGetMember
        name = stack.pop();
        obj = stack.pop();
        if (name === 'prototype') {
          // special case to track members
          stack.push(as2CreatePrototypeProxy(obj));
        } else {
          resolvedName = as2ResolveProperty(Object(obj), name);
          stack.push(resolvedName === null ? undefined :
                     obj.asGetPublicProperty(resolvedName));
        }
        break;
      case 0x42: // ActionInitArray
        obj = readArgs(stack);
        stack.push(obj);
        break;
      case 0x43: // ActionInitObject
        count = +stack.pop();
        validateArgsCount(count, stack.length >> 1);
        obj = {};
        for (i = 0; i < count; i++) {
          value = stack.pop();
          name = stack.pop();
          obj.asSetPublicProperty(name, value);
        }
        stack.push(obj);
        break;
      case 0x53: // ActionNewMethod
        methodName = stack.pop();
        obj = stack.pop();
        args = readArgs(stack);
        stackItemsExpected++;
        // checking "if the name of the method is blank"
        if (methodName !== null && methodName !== undefined &&
            methodName !== '') {
          resolvedName = as2ResolveProperty(obj, methodName);
          if (resolvedName === null) {
            throw new Error('Method ' + methodName + ' is not defined.');
          }
          if (obj === null || obj === undefined) {
            throw new Error('Cannot call new using method ' + resolvedName + ' of ' + typeof obj);
          }
          method = obj.asGetPublicProperty(resolvedName);
        } else {
          if (obj === null || obj === undefined) {
            throw new Error('Cannot call new using ' + typeof obj);
          }
          method = obj;
        }
        if (isAvm2Class(obj)) {
          result = construct(obj, args);
        } else {
          result = Object.create(as2GetPrototype(method) || as2GetPrototype(Object));
          method.apply(result, args);
        }
        result.constructor = method;
        stack.push(result);
        break;
      case 0x40: // ActionNewObject
        objectName = stack.pop();
        obj = getObjectByName(objectName);
        args = readArgs(stack);
        stackItemsExpected++;
        result = createBuiltinType(obj, args);
        if (typeof result === 'undefined') {
          // obj in not a built-in type
          if (isAvm2Class(obj)) {
            result = construct(obj, args);
          } else {
            result = Object.create(as2GetPrototype(obj) || as2GetPrototype(Object));
            obj.apply(result, args);
          }
          result.constructor = obj;
        }
        stack.push(result);
        break;
      case 0x4F: // ActionSetMember
        value = stack.pop();
        name = stack.pop();
        obj = stack.pop();
        obj.asSetPublicProperty(name, value);
        break;
      case 0x45: // ActionTargetPath
        obj = stack.pop();
        stack.push(as2GetType(obj) === 'movieclip' ? obj._target : void(0));
        break;
      case 0x94: // ActionWith
        codeSize = stream.readUI16();
        obj = stack.pop();
        nextPosition += codeSize;
        processWith(obj, stream.readBytes(codeSize));
        break;
      case 0x4A: // ActionToNumber
        stack.push(as2ToNumber(stack.pop()));
        break;
      case 0x4B: // ActionToString
        stack.push(as2ToString(stack.pop()));
        break;
      case 0x44: // ActionTypeOf
        obj = stack.pop();
        result = as2GetType(obj);
        stack.push(result);
        break;
      case 0x47: // ActionAdd2
        a = as2ToAddPrimitive(stack.pop());
        b = as2ToAddPrimitive(stack.pop());
        if (typeof a === 'string' || typeof b === 'string') {
          stack.push(as2ToString(b) + as2ToString(a));
        } else {
          stack.push(as2ToNumber(b) + as2ToNumber(a));
        }
        break;
      case 0x48: // ActionLess2
        a = stack.pop();
        b = stack.pop();
        stack.push(as2Compare(b, a));
        break;
      case 0x3F: // ActionModulo
        a = as2ToNumber(stack.pop());
        b = as2ToNumber(stack.pop());
        stack.push(b % a);
        break;
      case 0x60: // ActionBitAnd
        a = as2ToInt32(stack.pop());
        b = as2ToInt32(stack.pop());
        stack.push(b & a);
        break;
      case 0x63: // ActionBitLShift
        a = as2ToInt32(stack.pop());
        b = as2ToInt32(stack.pop());
        stack.push(b << a);
        break;
      case 0x61: // ActionBitOr
        a = as2ToInt32(stack.pop());
        b = as2ToInt32(stack.pop());
        stack.push(b | a);
        break;
      case 0x64: // ActionBitRShift
        a = as2ToInt32(stack.pop());
        b = as2ToInt32(stack.pop());
        stack.push(b >> a);
        break;
      case 0x65: // ActionBitURShift
        a = as2ToInt32(stack.pop());
        b = as2ToInt32(stack.pop());
        stack.push(b >>> a);
        break;
      case 0x62: // ActionBitXor
        a = as2ToInt32(stack.pop());
        b = as2ToInt32(stack.pop());
        stack.push(b ^ a);
        break;
      case 0x51: // ActionDecrement
        a = as2ToNumber(stack.pop());
        a--;
        stack.push(a);
        break;
      case 0x50: // ActionIncrement
        a = as2ToNumber(stack.pop());
        a++;
        stack.push(a);
        break;
      case 0x4C: // ActionPushDuplicate
        stack.push(stack[stack.length - 1]);
        break;
      case 0x3E: // ActionReturn
        return stack.pop(); // return
      case 0x4D: // ActionStackSwap
        stack.push(stack.pop(), stack.pop());
        break;
      case 0x87: // ActionStoreRegister
        register = stream.readUI8();
        registers[register] = stack[stack.length - 1];
        break;
      // SWF 6
      case 0x54: // ActionInstanceOf
        constr = stack.pop();
        obj = stack.pop();
        stack.push(as2InstanceOf(Object(obj), constr));
        break;
      case 0x55: // ActionEnumerate2
        obj = stack.pop();
        stack.push(null);
        /*jshint -W083 */
        forEachPublicProperty(obj, function (name) {
          stack.push(name);
        });
        break;
      case 0x66: // ActionStrictEquals
        a = stack.pop();
        b = stack.pop();
        stack.push(b === a);
        break;
      case 0x67: // ActionGreater
        a = stack.pop();
        b = stack.pop();
        stack.push(as2Compare(a, b));
        break;
      case 0x68: // ActionStringGreater
        sa = as2ToString(stack.pop());
        sb = as2ToString(stack.pop());
        f = sb > sa;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      // SWF 7
      case 0x8E: // ActionDefineFunction2
        functionName = stream.readString();
        count = stream.readUI16();
        var registerCount = stream.readUI8();
        flags = stream.readUI16();
        var registerAllocation = [];
        args = [];
        for (i = 0; i < count; i++) {
          register = stream.readUI8();
          paramName = stream.readString();
          args.push(paramName);
          if (register) {
            registerAllocation[register] = {
              type: 'param',
              name: paramName,
              index: i
            };
          }
        }
        codeSize = stream.readUI16();
        nextPosition += codeSize;

        var j = 1;
        // order this, arguments, super, _root, _parent, and _global
        if (flags & 0x0001) { // preloadThis
          registerAllocation[j++] = { type: 'var', name: 'this' };
        }
        if (flags & 0x0004) { // preloadArguments
          registerAllocation[j++] = { type: 'var', name: 'arguments' };
        }
        if (flags & 0x0010) { // preloadSuper
          registerAllocation[j++] = { type: 'var', name: 'super' };
        }
        if (flags & 0x0040) { // preloadRoot
          registerAllocation[j++] = { type: 'var', name: '_root' };
        }
        if (flags & 0x0080) { // preloadParent
          registerAllocation[j++] = { type: 'var', name: '_parent' };
        }
        if (flags & 0x0100) { // preloadGlobal
          registerAllocation[j++] = { type: 'var', name: '_global' };
        }

        fn = defineFunction(functionName, args,
                            registerAllocation, stream.readBytes(codeSize));
        if (functionName) {
          scope.asSetPublicProperty(functionName, fn);
        } else {
          stack.push(fn);
        }
        break;
      case 0x69: // ActionExtends
        var constrSuper = stack.pop();
        constr = stack.pop();
        obj = Object.create(constrSuper.traitsPrototype || as2GetPrototype(constrSuper), {
          constructor: { value: constr, enumerable: false }
        });
        constr.__super = constrSuper;
        constr.prototype = obj;
        break;
      case 0x2B: // ActionCastOp
        obj =  stack.pop();
        constr = stack.pop();
        stack.push(as2InstanceOf(obj, constr) ? obj : null);
        break;
      case 0x2C: // ActionImplementsOp
        constr = stack.pop();
        count = +stack.pop();
        validateArgsCount(count, stack.length);
        var interfaces = [];
        for (i = 0; i < count; i++) {
          interfaces.push(stack.pop());
        }
        constr.$interfaces = interfaces;
        break;
      case 0x8F: // ActionTry
        flags = stream.readUI8();
        var catchIsRegisterFlag = !!(flags & 4);
        var finallyBlockFlag = !!(flags & 2);
        var catchBlockFlag = !!(flags & 1);
        var trySize = stream.readUI16();
        var catchSize = stream.readUI16();
        var finallySize = stream.readUI16();
        var catchTarget = catchIsRegisterFlag ? stream.readUI8() : stream.readString();
        nextPosition += trySize + catchSize + finallySize;
        processTry(catchIsRegisterFlag, finallyBlockFlag, catchBlockFlag, catchTarget,
          stream.readBytes(trySize), stream.readBytes(catchSize), stream.readBytes(finallySize));
        break;
      case 0x2A: // ActionThrow
        obj = stack.pop();
        throw new AS2Error(obj);
      // Not documented by the spec
      case 0x2D: // ActionFSCommand2
        args = readArgs(stack);
        stackItemsExpected++;
        result = _global.fscommand.apply(null, args);
        stack.push(result);
        break;
      case 0x89: // ActionStrictMode
        var mode = stream.readUI8();
        break;
      case 0: // End of actions
        return;
      default:
        throw new Error('Unknown action code: ' + actionCode);
    }
    stream.position = nextPosition;
    recoveringFromError = false;
  }

    // handling AVM1 errors
    } catch (e) {
      if ((!AVM1_ERRORS_IGNORED && !currentContext.isTryCatchListening) ||
          e instanceof AS2CriticalError) {
        throw e;
      }
      if (e instanceof AS2Error) {
        throw e;
      }

      var AVM1_ERROR_TYPE = 1;
      TelemetryService.reportTelemetry({topic: 'error', error: AVM1_ERROR_TYPE});

      stream.position = nextPosition;
      if (stackItemsExpected > 0) {
        while (stackItemsExpected--) {
          stack.push(undefined);
        }
      }
      if (!recoveringFromError) {
        if (currentContext.errorsIgnored++ >= MAX_AVM1_ERRORS_LIMIT) {
          throw new AS2CriticalError('long running script -- AVM1 errors limit is reached');
        }
        console.error('AVM1 error: ' + e);
        avm2.exceptions.push({source: 'avm1', message: e.message,
                              stack: e.stack});
        recoveringFromError = true;
      }
    }
  }
}

var ActionTracerFactory = (function() {
  var indentation = 0;
  var tracer = {
    print: function(position, actionCode, stack) {
      var stackDump = [];
      for(var q = 0; q < stack.length; q++) {
        var item = stack[q];
        stackDump.push(item && typeof item === 'object' ?
          '[' + (item.constructor && item.constructor.name ? item.constructor.name : 'Object') + ']' : item);
      }

      var indent = new Array(indentation + 1).join('..');

      console.log('AVM1 trace: ' + indent + position + ': ' +
        ActionNamesMap[actionCode] + '(' + actionCode.toString(16) + '), ' +
        'stack=' + stackDump);
    },
    indent: function() {
      indentation++;
    },
    unindent: function() {
      indentation--;
    },
    message: function(str) {
      console.log('AVM1 trace: ------- ' + str);
    }
  };
  var nullTracer = {
    print: function() {},
    indent: function() {},
    unindent: function() {},
    message: function() {}
  };

  function ActionTracerFactory() {}
  ActionTracerFactory.get = (function() {
    return AVM1_TRACE_ENABLED ? tracer : nullTracer;
  });
  return ActionTracerFactory;
})();

var ActionNamesMap = {
  0x00: 'EOA',
  0x04: 'ActionNextFrame',
  0x05: 'ActionPreviousFrame',
  0x06: 'ActionPlay',
  0x07: 'ActionStop',
  0x08: 'ActionToggleQuality',
  0x09: 'ActionStopSounds',
  0x0A: 'ActionAdd',
  0x0B: 'ActionSubtract',
  0x0C: 'ActionMultiply',
  0x0D: 'ActionDivide',
  0x0E: 'ActionEquals',
  0x0F: 'ActionLess',
  0x10: 'ActionAnd',
  0x11: 'ActionOr',
  0x12: 'ActionNot',
  0x13: 'ActionStringEquals',
  0x14: 'ActionStringLength',
  0x15: 'ActionStringExtract',
  0x17: 'ActionPop',
  0x18: 'ActionToInteger',
  0x1C: 'ActionGetVariable',
  0x1D: 'ActionSetVariable',
  0x20: 'ActionSetTarget2',
  0x21: 'ActionStringAdd',
  0x22: 'ActionGetProperty',
  0x23: 'ActionSetProperty',
  0x24: 'ActionCloneSprite',
  0x25: 'ActionRemoveSprite',
  0x26: 'ActionTrace',
  0x27: 'ActionStartDrag',
  0x28: 'ActionEndDrag',
  0x29: 'ActionStringLess',
  0x2A: 'ActionThrow',
  0x2B: 'ActionCastOp',
  0x2C: 'ActionImplementsOp',
  0x2D: 'ActionFSCommand2',
  0x30: 'ActionRandomNumber',
  0x31: 'ActionMBStringLength',
  0x32: 'ActionCharToAscii',
  0x33: 'ActionAsciiToChar',
  0x34: 'ActionGetTime',
  0x35: 'ActionMBStringExtrac',
  0x36: 'ActionMBCharToAscii',
  0x37: 'ActionMBAsciiToChar',
  0x3A: 'ActionDelete',
  0x3B: 'ActionDelete2',
  0x3C: 'ActionDefineLocal',
  0x3D: 'ActionCallFunction',
  0x3E: 'ActionReturn',
  0x3F: 'ActionModulo',
  0x40: 'ActionNewObject',
  0x41: 'ActionDefineLocal2',
  0x42: 'ActionInitArray',
  0x43: 'ActionInitObject',
  0x44: 'ActionTypeOf',
  0x45: 'ActionTargetPath',
  0x46: 'ActionEnumerate',
  0x47: 'ActionAdd2',
  0x48: 'ActionLess2',
  0x49: 'ActionEquals2',
  0x4A: 'ActionToNumber',
  0x4B: 'ActionToString',
  0x4C: 'ActionPushDuplicate',
  0x4D: 'ActionStackSwap',
  0x4E: 'ActionGetMember',
  0x4F: 'ActionSetMember',
  0x50: 'ActionIncrement',
  0x51: 'ActionDecrement',
  0x52: 'ActionCallMethod',
  0x53: 'ActionNewMethod',
  0x54: 'ActionInstanceOf',
  0x55: 'ActionEnumerate2',
  0x60: 'ActionBitAnd',
  0x61: 'ActionBitOr',
  0x62: 'ActionBitXor',
  0x63: 'ActionBitLShift',
  0x64: 'ActionBitRShift',
  0x65: 'ActionBitURShift',
  0x66: 'ActionStrictEquals',
  0x67: 'ActionGreater',
  0x68: 'ActionStringGreater',
  0x69: 'ActionExtends',
  0x81: 'ActionGotoFrame',
  0x83: 'ActionGetURL',
  0x87: 'ActionStoreRegister',
  0x88: 'ActionConstantPool',
  0x89: 'ActionStrictMode',
  0x8A: 'ActionWaitForFrame',
  0x8B: 'ActionSetTarget',
  0x8C: 'ActionGoToLabel',
  0x8D: 'ActionWaitForFrame2',
  0x8E: 'ActionDefineFunction',
  0x8F: 'ActionTry',
  0x94: 'ActionWith',
  0x96: 'ActionPush',
  0x99: 'ActionJump',
  0x9A: 'ActionGetURL2',
  0x9B: 'ActionDefineFunction',
  0x9D: 'ActionIf',
  0x9E: 'ActionCall',
  0x9F: 'ActionGotoFrame2'
};

// exports for testing
if (typeof GLOBAL !== 'undefined') {
  GLOBAL.createBuiltinType = createBuiltinType;
  GLOBAL.executeActions = executeActions;
  GLOBAL.AS2Context = AS2Context;
}
