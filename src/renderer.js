import pjson from '../package.json';
import { BrowserWindow } from 'electron';
import retry from 'retry';

import { validateResult, RendererError } from './error_handler';

const TIMEOUT = process.env.TIMEOUT || 30;
const DELAY = process.env.DELAY || 1;
const WINDOW_WIDTH = parseInt(process.env.WINDOW_WIDTH, 10) || 1024;
const WINDOW_HEIGHT = parseInt(process.env.WINDOW_HEIGHT, 10) || 768;
const LIMIT = 3000; // Constrain screenshots to 3000x3000px
const DEVELOPMENT = process.env.NODE_ENV === 'development';
const DEFAULT_HEADERS = 'Cache-Control: no-cache, no-store, must-revalidate';

/**
 * Render PDF
 */
function renderPDF({ options }, done) {
  // Remove print stylesheets prior rendering
  if (options.removePrintMedia) {
    const selector = 'document.querySelectorAll(\'link[rel="stylesheet"][media="print"]\')';
    const code = `Array.prototype.forEach.call(${selector}, s => s.remove());`;
    this.webContents.executeJavaScript(code);
  }

  this.webContents.printToPDF(options, done);
}

/**
 * Render image
 */
function renderImage({ type, options }, done) {
  const handleCapture = image => {
    done(null, type === 'png' ? image.toPng() : image.toJpeg(parseInt(options.quality, 10) || 80));
  };

  // Sanitize rect
  const validKeys = ['x', 'y', 'width', 'height'];
  const rect = {};
  Object.keys(options).map(k => [k, options[k]])
    .filter(([k, v]) => validKeys.includes(k) && !isNaN(parseInt(v, 10)))
    .forEach(([k, v]) => rect[k] = parseInt(v, 10));

  // Use explicit browser size or rect size, capped by LIMIT, default to ENV variable
  const browserSize = {
    width: Math.min(parseInt(options.browserWidth, 10) || rect.width, LIMIT) || WINDOW_WIDTH,
    height: Math.min(parseInt(options.browserHeight, 10) || rect.height, LIMIT) || WINDOW_HEIGHT,
  };

  if (Object.keys(rect).length === 4) {
    // Avoid stretching by adding rect coordinates to size
    this.setSize(browserSize.width + rect.x, browserSize.height + rect.y);
    setTimeout(() => this.capturePage(rect, handleCapture), 50);
  } else {
    this.setSize(browserSize.width, browserSize.height);
    setTimeout(() => this.capturePage(handleCapture), 50);
  }
}

/**
 * Render job with error handling
 */
export function renderWorker(window, task, done) {
  const { webContents } = window;

  if (task.url.startsWith('chrome://')) {
    return done(new RendererError('INVALID_URL', 'chrome:// urls are forbidden.'));
  }

  const timeoutTimer = setTimeout(() => webContents.emit('timeout'), TIMEOUT * 1000);
  var timeoutHit = false

  console.log('render worker')
  var renderType

  if (task.options.waitForText !== false) {
    var waitOperation = retry.operation({
      retries: TIMEOUT,
      factor: 1,
      minTimeout: 750,
      maxTimeout: 1000
    })
  }
  
  function renderIt(task, type, ...args) {
    clearTimeout(timeoutTimer);

    validateResult(task.url, type)
      .then(() => {
        // Page loaded successfully
        (task.type === 'pdf' ? renderPDF : renderImage).call(window, task, done);
      })
      .catch(ex => done(ex));
  }

  webContents.on('timeout', function() {
    done(new Error('timeout was hit'))
  })

  webContents.once('finished', (type) => {
    if (task.options.delay > 0) {
      console.log('delaying pdf generation by ', task.options.delay * 1000)
      setTimeout(renderIt.bind(null, task, type), task.options.delay * 1000);
    }
    else if (task.options.waitForText && task.options.waitForText !== 'false' && task.options.waitForText !== false) {
      console.log('delaying pdf generation, waiting for "' + task.options.waitForText + '" to appear')

      waitOperation.attempt(function(currentAttempt) {
        console.log('attempting to find text', currentAttempt)

        webContents.once('found-in-page', function(event, result) {
          if (result.finalUpdate && result.matches > 0 || result.finalUpdate == false && result.activeMatchOrdinal > 0) {
            webContents.stopFindInPage('clearSelection');
            return renderIt(task, type);
          }
          
          if (waitOperation.retry(new Error('not ready to render'))) {
            return;
          }
        });

        webContents.findInPage(task.options.waitForText);
      })
    }
    else {
      renderIt(task, type);
    }
  });

  

  webContents.loadURL(task.url, { extraHeaders: DEFAULT_HEADERS });
}

/**
 * Create BrowserWindow
 */
export function createWindow() {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH, height: WINDOW_HEIGHT,
    frame: DEVELOPMENT, show: DEVELOPMENT,
    webPreferences: {
      blinkFeatures: 'OverlayScrollbars', // Slimmer scrollbars
      allowDisplayingInsecureContent: true, // Show http content on https site
      allowRunningInsecureContent: true, // Run JS, CSS from http urls
    },
  });

  // Set user agent
  const { webContents } = window;
  webContents.setUserAgent(`${webContents.getUserAgent()} ${pjson.name}/${pjson.version}`);

  // Emit end events to an aggregate for worker to listen on once
  ['did-fail-load', 'crashed', 'did-finish-load', 'timeout'].forEach(e => {
    webContents.on(e, (...args) => webContents.emit('finished', e, ...args));
  });

  return window;
}
