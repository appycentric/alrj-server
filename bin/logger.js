/*========================================
   ALRJ Server logger + http access logger.

   To use, requre in the app.js like this: LOG = require('./utils/logger')(app);
   
   Usage: 
   LOG.info("Test splat: number %d,  string %s.", 123.45, "Winston");
   LOG.log('info', "Test splat: number %d,  string %s.", 123.45, "Winston");
==========================================*/
const moment           = require('moment');
const winston          = require('winston');
winston.transports.DailyRotateFile = require('winston-daily-rotate-file');

// const jwt              = require('jsonwebtoken');
const morganLogger     = require('morgan');
const rfs              = require('rotating-file-stream');
const fs               = require('fs');
const path             = require('path');
let alreadyInitialized = false;

let LoggerException = (message) => {
    this.message = message;
    this.name = 'LoggerException';
}

/*========================================
    Logger - Winston (application logger)
==========================================*/
const { createLogger, format, transports }  = winston;
const { combine, timestamp, label, printf } = format;

let customFileFormatter = (options) => {
    return options.timestamp() +' ['+ options.level.toUpperCase() +'] '+ (undefined !== options.message ? options.message : '') +
     (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' );
}

const getTimestamp = () => {
    return moment().utcOffset(0).format('YYYY-MM-DD_HH:mm:ss:SSS');
};

const myFormat = winston.format.printf(info => {
    return logFormatter(info);
});

const logFormatter = (options) => {
    return getTimestamp() +` `+ options.level.toUpperCase() +
        ` `+ (options.message ? options.message : ``) +
        (options.meta && Object.keys(options.meta).length ?
            `\n\t`+ JSON.stringify(options.meta) : `` );
};


let errorRotate = new winston.transports.DailyRotateFile({
    level: 'error',
    filename: path.join(__dirname, '../logs/%DATE%-error.log'),
    datePattern: 'YYYYMMDD',
    handleExceptions: true,
    maxSize: '100m'
});

let debugRotate = new winston.transports.DailyRotateFile({
    level: 'debug',
    filename: path.join(__dirname, '../logs/%DATE%-debug.log'),
    datePattern: 'YYYYMMDD',
    handleExceptions: true,
    maxSize: '100m'
});


let logger = createLogger({
    format: format.combine(
        format.splat(),
        format.simple(),
        myFormat
    ),
    transports: [
        errorRotate,
        debugRotate,    
        new transports.Console({
            level: 'debug',
            handleExceptions: true,
            json: false,
            colorize: true,
        })
    ],
    exitOnError: false
});

logger.log('info', "Starting ALRJ server logger...");
logger.on('error', (err) => { 
    console.log("--- Error in logger itself! --- " + err);
});


/*=========================================
    Logger - Morgan  (http access logger)
===========================================*/
// Define list of specific routes whose publicly available
morganLogger.token('referer', getReferrer = (req) => {
    return req.headers.referer ? req.headers.referer : '-';
});
// Add authorized user id into log info
// morganLogger.token('remote-user', getId = (req) => {
//     return jwt.decode(req.headers.authorization) ? jwt.decode(req.headers.authorization)['sub'] : 'Unregistered or Outside user';
// });

// Filename generators
const accessLogGenerator = (time, index) => {
    console.log('INDEX: ', index);
    if (!time || index == 0) {
        return moment(new Date()).format('YYYYMMDD') + '-access.log';
    }
    else {
        let logFiles = fs.readdirSync(path.join(__dirname, '../logs'));
        if (!logFiles) {
            return moment(new Date()).format('YYYYMMDD') + '-access-' + moment(new Date()).format('hhmmss') + '.log';
        }
        else {
            let fileSn = 0;
            for (let i=0; i<logFiles.length; i++) {
                if (logFiles[i].includes('access') && logFiles[i].includes(moment(new Date()).format('YYYYMMDD'))) {
                    fileSn += 1;
                }
            }

            if (fileSn > 0) {
                return moment(new Date()).format('YYYYMMDD') + '-access-' + fileSn + '.log';
            }
            else {
                return moment(new Date()).format('YYYYMMDD') + '-access.log';
            }
        }
    }
};

module.exports = (app) => { 
    // use app here:
    if (alreadyInitialized) {
        logger.info("Reusing logger...");
        return logger;
    }

    if (app == null) {
        err = "The application object is null [ e.g. app=express(); ], but it must be provided, to allow initialization of the logging subsystem.";
        throw new LoggerException(err);
    }
    
    accessLogStream = rfs.createStream(accessLogGenerator, {
        interval: '1d', // rotate daily
        size: '200B',
        path: path.join(__dirname, '../logs')
    });

    app.use( morganLogger(
        ':remote-addr [:date[iso]] ":method :url HTTP/:http-version" :status :res[content-length] ":referer" ":user-agent"', { 
        stream: accessLogStream
    }));
    
    alreadyInitialized = true;
    return logger;
};

module.exports.stream = {
    write: (message, encoding) => {
        logger.info(message);
    }
};