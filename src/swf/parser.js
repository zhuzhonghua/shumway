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
/*global SWF, MOVIE_HEADER, SWF_TAG_CODE_FILE_ATTRIBUTES, tagHandler, Stream,
         readUi32, readUi16, Blob, StreamNoDataError, parseJpegChunks,
         generateParser, inflateBlock, verifyDeflateHeader, InflateNoDataError,
         readHeader */
/*jshint -W069 */

function readTags(context, stream, swfVersion, final, onprogress, onexception) {
  var tags = context.tags;
  var bytes = stream.bytes;
  var lastSuccessfulPosition;

  var tag = null;
  if (context._readTag) {
    tag = context._readTag;
    context._readTag = null;
  }

  try {
    while (stream.pos < stream.end) {
      // this loop can be interrupted at any moment by StreamNoDataError
      // exception, trying to recover data/position below when thrown
      lastSuccessfulPosition = stream.pos;

      stream.ensure(2);
      var tagCodeAndLength = readUi16(bytes, stream);
      if (!tagCodeAndLength) {
        // end of tags
        final = true;
        break;
      }

      var tagCode = tagCodeAndLength >> 6;
      var length = tagCodeAndLength & 0x3f;
      if (length === 0x3f) {
        stream.ensure(4);
        length = readUi32(bytes, stream);
      }

      if (tag) {
        if (tagCode === 1 && tag.code === 1) {
          // counting ShowFrame
          tag.repeat++;
          stream.pos += length;
          continue;
        }
        tags.push(tag);
        if (onprogress && tag.id !== undefined) {
          onprogress(context);
        }
        tag = null;
      }

      stream.ensure(length);
      var substream = stream.substream(stream.pos, stream.pos += length);
      var subbytes = substream.bytes;
      var nextTag = { code: tagCode };

      if (tagCode === 39) {
        nextTag.type = 'sprite';
        nextTag.id = readUi16(subbytes, substream);
        nextTag.frameCount = readUi16(subbytes, substream);
        nextTag.tags = [];
        readTags(nextTag, substream, swfVersion, true);
      } else if (tagCode === 1) {
        nextTag.repeat = 1;
      } else {
        var handler = tagHandler[tagCode];
        if (handler) {
          handler(subbytes, substream, nextTag, swfVersion, tagCode);
        }
      }

      tag = nextTag;
    }
    if (tag && final) {
      tag.finalTag = true; // note: 'eot' is reserved by handlers
      tags.push(tag);
      if (onprogress) {
        onprogress(context);
      }
    } else {
      context._readTag = tag;
    }
  } catch (e) {
    if (e !== StreamNoDataError) {
      onexception && onexception(e);
      throw e;
    }
    // recovering the stream state
    stream.pos = lastSuccessfulPosition;
    context._readTag = tag;
  }
}

function HeadTailBuffer(defaultSize) {
  this.bufferSize = defaultSize || 16;
  this.buffer = new Uint8Array(this.bufferSize);
  this.pos = 0;
}
HeadTailBuffer.prototype = {
  push: function (data, need) {
    var bufferLengthNeed = this.pos + data.length;
    if (this.bufferSize < bufferLengthNeed) {
      var newBufferSize = this.bufferSize;
      while (newBufferSize < bufferLengthNeed) {
        newBufferSize <<= 1;
      }
      var newBuffer = new Uint8Array(newBufferSize);
      if (this.bufferSize > 0) {
        newBuffer.set(this.buffer);
      }
      this.buffer = newBuffer;
      this.bufferSize = newBufferSize;
    }
    this.buffer.set(data, this.pos);
    this.pos += data.length;
    if (need)
      return this.pos >= need;
  },
  getHead: function (size) {
    return this.buffer.subarray(0, size);
  },
  getTail: function (offset) {
    return this.buffer.subarray(offset, this.pos);
  },
  removeHead: function (size) {
    var tail = this.getTail(size);
    this.buffer = new Uint8Array(this.bufferSize);
    this.buffer.set(tail);
    this.pos = tail.length;
  },
  get arrayBuffer() {
    return this.buffer.buffer;
  },
  get length() {
    return this.pos;
  },
  createStream: function () {
    return new Stream(this.arrayBuffer, 0, this.length);
  }
};

function CompressedPipe(target, length) {
  this.target = target;
  this.length = length;
  this.initialize = true;
  this.buffer = new HeadTailBuffer(8096);
  this.state = { bitBuffer: 0, bitLength : 0, compression: {} };
  this.output = {
    data: new Uint8Array(length),
    available: 0,
    completed: false
  };
}

CompressedPipe.prototype = {
  push: function (data, progressInfo) {
    var buffer = this.buffer;
    if (this.initialize) {
      if (!buffer.push(data, 2))
        return;
      var headerBytes = buffer.getHead(2);
      verifyDeflateHeader(headerBytes);
      buffer.removeHead(2);
      this.initialize = false;
    } else {
      buffer.push(data);
    }
    var stream = buffer.createStream();
    stream.bitBuffer = this.state.bitBuffer;
    stream.bitLength = this.state.bitLength;
    var output = this.output;
    var lastAvailable = output.available;
    try {
      do {
        inflateBlock(stream, output, this.state.compression);
      } while (stream.pos < buffer.length && !output.completed);
    } catch (e) {
      if (e !== InflateNoDataError) throw e; // re-throw non data errors
    } finally {
      this.state.bitBuffer = stream.bitBuffer;
      this.state.bitLength = stream.bitLength;
    }
    buffer.removeHead(stream.pos);

    // push data downstream
    this.target.push(output.data.subarray(lastAvailable, output.available),
                     progressInfo);
  }
};

function BodyParser(swfVersion, length, options) {
  this.swf = {
    swfVersion: swfVersion,
    parseTime: 0
  };
  this.buffer = new HeadTailBuffer(32768);
  this.initialize = true;
  this.totalRead = 0;
  this.length = length;
  this.options = options;
}
BodyParser.prototype = {
  push: function (data, progressInfo) {
    if (data.length === 0)
      return;

    var swf = this.swf;
    var swfVersion = swf.swfVersion;
    var buffer = this.buffer;
    var options = this.options;
    var stream;
    if (this.initialize) {
      var PREFETCH_SIZE = 17 /* RECT */ +
                          4  /* Frames rate and count */ +
                          6  /* FileAttributes */;
      if (!buffer.push(data, PREFETCH_SIZE))
        return;

      stream = buffer.createStream();
      var bytes = stream.bytes;
      readHeader(bytes, stream, swf);

      // reading FileAttributes tag, this tag shall be first in the file
      var nextTagHeader = readUi16(bytes, stream);
      var FILE_ATTRIBUTES_LENGTH = 4;
      if (nextTagHeader == ((SWF_TAG_CODE_FILE_ATTRIBUTES << 6) | FILE_ATTRIBUTES_LENGTH)) {
        stream.ensure(FILE_ATTRIBUTES_LENGTH);
        var substream = stream.substream(stream.pos, stream.pos += FILE_ATTRIBUTES_LENGTH);
        var handler = tagHandler[SWF_TAG_CODE_FILE_ATTRIBUTES];
        var fileAttributesTag = {code: SWF_TAG_CODE_FILE_ATTRIBUTES};
        handler(substream.bytes, substream, fileAttributesTag, swfVersion, SWF_TAG_CODE_FILE_ATTRIBUTES);
        swf.fileAttributes = fileAttributesTag;
      } else {
        stream.pos -= 2; // FileAttributes tag was not found -- re-winding
        swf.fileAttributes = {}; // using empty object here, defaults all attributes to false
      }

      if (options.onstart)
        options.onstart(swf);

      swf.tags = [];

      this.initialize = false;
    } else {
      buffer.push(data);
      stream = buffer.createStream();
    }

    var finalBlock = false;
    if (progressInfo) {
      swf.bytesLoaded = progressInfo.bytesLoaded;
      swf.bytesTotal = progressInfo.bytesTotal;
      finalBlock = progressInfo.bytesLoaded >= progressInfo.bytesTotal;
    }

    var readStartTime = performance.now();
    readTags(swf, stream, swfVersion, finalBlock, options.onprogress,
             options.onexception);
    swf.parseTime += performance.now() - readStartTime;

    var read = stream.pos;
    buffer.removeHead(read);
    this.totalRead += read;

    if (options.oncomplete && swf.tags[swf.tags.length - 1].finalTag) {
      options.oncomplete(swf);
    }
  }
};

SWF.parseAsync = function swf_parseAsync(options) {
  var buffer = new HeadTailBuffer();
  var pipe = {
    push: function (data, progressInfo) {
      if (this.target !== undefined) {
        return this.target.push(data, progressInfo);
      }
      if (!buffer.push(data, 8)) {
        return null;
      }
      var bytes = buffer.getHead(8);
      var magic1 = bytes[0];
      var magic2 = bytes[1];
      var magic3 = bytes[2];

      // check for SWF
      if ((magic1 === 70 || magic1 === 67) && magic2 === 87 && magic3 === 83) {
        var swfVersion = bytes[3];
        var compressed = magic1 === 67;
        parseSWF(compressed, swfVersion, progressInfo);
        buffer = null;
        return;
      }

      var isImage = false;
      var imageType;

      // check for JPG
      if (magic1 === 0xff && magic2 === 0xd8 && magic3 === 0xff) {
        isImage = true;
        imageType = 'image/jpeg';
      } else if (magic1 === 0x89 && magic2 === 0x50 && magic3 === 0x4e) {
        isImage = true;
        imageType = 'image/png';
      }

      if (isImage) {
        parseImage(data, progressInfo.bytesTotal, imageType);
      }
      buffer = null;
    },
    close: function () {
      if (buffer) {
        // buffer was closed: none or few bytes were received
        var symbol = {
          command: 'empty',
          data : buffer.buffer.subarray(0, buffer.pos)
        };
        options.oncomplete && options.oncomplete(symbol);
      }
      if (this.target !== undefined && this.target.close) {
        this.target.close();
      }
    }
  };

  function parseSWF(compressed, swfVersion, progressInfo) {
    var stream = buffer.createStream();
    stream.pos += 4;
    var fileLength = readUi32(null, stream);
    var bodyLength = fileLength - 8;

    var target = new BodyParser(swfVersion, bodyLength, options);
    if (compressed) {
      target = new CompressedPipe(target, bodyLength);
    }
    target.push(buffer.getTail(8), progressInfo);
    pipe["target"] = target;
  }

  function parseImage(data, bytesTotal, type) {
    var buffer = new Uint8Array(bytesTotal);
    buffer.set(data);
    var bufferPos = data.length;

    pipe["target"] = {
      push: function (data) {
        buffer.set(data, bufferPos);
        bufferPos += data.length;
      },
      close: function () {
        var props = {};
        var chunks;
        if (type == 'image/jpeg') {
          chunks = parseJpegChunks(props, buffer);
        } else {
          chunks = [buffer];
        }
        var symbol = {
          type: 'image',
          props: props,
          data : new Blob(chunks, {type: type})
        };
        options.oncomplete && options.oncomplete(symbol);
      }
    };
  }

  return pipe;
};

SWF.parse = function(buffer, options) {
  if (!options)
    options = { };

  var pipe = SWF.parseAsync(options);
  var bytes = new Uint8Array(buffer);
  var progressInfo = { bytesLoaded: bytes.length, bytesTotal: bytes.length };
  pipe.push(bytes, progressInfo);
  pipe.close();
};
