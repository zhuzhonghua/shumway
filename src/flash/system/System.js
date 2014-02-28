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
/*global FirefoxCom, TelemetryService, CLIPBOARD_FEATURE,
         renderingTerminated: true */

var SystemDefinition = (function () {
  return {
    __class__: "flash.system.System",
    initialize: function () {
    },
    __glue__: {
      native: {
        static: {
          setClipboard: function setClipboard(string) { // (string:String) -> void
            FirefoxCom.request('setClipboard', string);

            TelemetryService.reportTelemetry({topic: 'feature', feature: CLIPBOARD_FEATURE});
          },
          pause: function pause() { // (void) -> void
            somewhatImplemented("System.pause");
          },
          resume: function resume() { // (void) -> void
            somewhatImplemented("System.resume");
          },
          exit: function exit(code) { // (code:uint) -> void
            somewhatImplemented("System.exit");
            renderingTerminated = true;
          },
          gc: function gc() { // (void) -> void
            somewhatImplemented("System.gc");
          },
          pauseForGCIfCollectionImminent: function pauseForGCIfCollectionImminent(imminence) { // (imminence:Number = 0.75) -> void
            notImplemented("System.pauseForGCIfCollectionImminent");
          },
          disposeXML: function disposeXML(node) { // (node:XML) -> void
            notImplemented("System.disposeXML");
          },
          ime: {
            get: function ime() { // (void) -> IME
              notImplemented("System.ime");
            }
          },
          totalMemoryNumber: {
            get: function totalMemoryNumber() { // (void) -> Number
              if (performance.memory) {
                return performance.memory.usedJSHeapSize;
              }
              return 0;
            }
          },
          freeMemory: {
            get: function freeMemory() { // (void) -> Number
              notImplemented("System.freeMemory");
            }
          },
          privateMemory: {
            get: function privateMemory() { // (void) -> Number
              return 0;
            }
          },
          processCPUUsage: {
            get: function processCPUUsage() { // (void) -> Number
              notImplemented("System.processCPUUsage");
            }
          },
          useCodePage: {
            get: function useCodePage() { // (void) -> Boolean
              somewhatImplemented("System.useCodePage");
              return false;
            },
            set: function useCodePage(value) { // (value:Boolean) -> void
              notImplemented("System.useCodePage");
            }
          },
          vmVersion: {
            get: function vmVersion() { // (void) -> String
              somewhatImplemented("System.vmVersion");
              return "1.0 shumway";
            }
          },
          swfVersion: {
            get: function () {
              return 19;
            }
          },
          apiVersion: {
            get: function () {
              return 26;
            }
          },
          getArgv: function () {
            return [];
          },
          getRunmode: function () {
            return "mixed";
          }
        },
        instance: {
        }
      }
    }
  };
}).call(this);
