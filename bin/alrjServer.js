require('dotenv').config();
const express    = require('express');
const { spawn }  = require('child_process');
const ext        = process.platform == 'win32' ? '.cmd' : '.sh';
const slash      = process.platform == 'win32' ? '\\' : '/';
const fs         = require('fs');
const path       = require('path');
const bodyParser = require('body-parser');
const download   = require('download-file');
const moment     = require('moment');
const app        = express();
const http       = require('http');
const https      = require('https');
const FormData   = require('form-data');
const cwd        = process.cwd();

const { COMPRESSION_LEVEL, zip } = require('zip-a-folder');
const unzip = require('extract-zip');

// Logger
LOG = require('./logger')(app);

// CL Server Initialization
let CL_SERVER_READY = false;

// Different States
let COMPLETED_TASKS_IN_UPLOADING = 0;
let TASKS_IN_CLEANING_UP         = 0;
let ERROR_TASKS_IN_UPDATING      = 0;
let UPDATING_JOBS_STATUSES       = false;
let UPDATING_ERROR_JOBS_STATUSES = false;

// Tasks pools
let pendingTasks       = [];
let tasksInProcessing  = [];
let completedTasks     = [];
let errorTasks         = [];
let tasksForCleanup    = [];

// The last time logged
let lastTimePTLogged = null;
let lastTimeNewTasksStatusLogged = null;

const RET_NO_JOBID            = {status: 'error', code: 400, jobstatus: 7, info: 'No Job Id specified.'};
const RET_NO_API_CLASS        = {status: 'error', code: 400, jobstatus: 7, info: 'No API class specified.'};
const RET_NO_API_DIRECTORY    = {status: 'error', code: 400, jobstatus: 7, info: 'ALRJs\' (tasks\') directory not specified.'};
const RET_NO_LIMITS_INFO      = {status: 'error', code: 400, jobstatus: 7, info: 'No information about max pending or simultaneous tasks.'};
const RET_BAD_KEY             = {status: 'error', code: 400, info: 'No key or bad key specified.'};
const RET_NO_TIMEOUT          = {status: 'error', code: 400, info: 'Timeout is not specified.'};
const RET_NO_CAPACITY         = {status: 'error', code: 400, info: 'No resources availabe to accept a new task.'};
const RET_NO_CANCELATION      = {status: 'error', code: 403, info: 'Cancellation is not available'};
const RET_ALREADY_RUN         = {status: 'ok', code: 403, info: 'This job has already been run.', serverKey: process.env.SERVER_KEY}; // Should not happen if status of job set to "processing" prior to a request is sent to this server
const RET_JOB_PENDING         = {status: 'ok', code: 200, jobstatus: 9, info: 'Job is pending.', serverKey: process.env.SERVER_KEY};
const RET_JOB_IN_PROGRESS     = {status: 'ok', code: 200, jobstatus: 10, info: 'Job is in progress.'};

const RET_OK                  = {status: 'ok', code: 200};
const RET_JOB_EXECUTION_ERROR = {status: 'error', code: 500, jobstatus: 8, info: 'Job execution error.'};
const RET_JOB_NOT_FOUND       = {status: 'error', code: 400, jobstatus: 7, info: 'Job not found.'};
const RET_JOB_COMPLETE        = {status: 'ok', code: 200, jobstatus: 0, info: 'Job complete.'}; // job complete
const RET_JOB_TASK_COMPLETE   = {status: 'ok', code: 200, jobstatus: 0, info: 'Task complete.'}; // clean-up | delete complete

const RET_PING = {status: 'ok', code: 200, serverKey: process.env.SERVER_KEY, info: `Available URLs:
    ping: /getInfo
    start a new job: /startJob?key=n&jobId=n[&payload={<json-payload>}][&download=true][&upload=true]
    check status of a job: /getStatus?key=n&jobId=n
    retrieve job results: /getResults?key=n&jobId=n
    cancel a job: /cancelJob?key=n&jobId=n
    clean up a job: /cleanUpJob?key=n&jobId=n
`
};

const KEY_MIN_LENGTH = 8;

// Server key validation
if( !process.env.SERVER_KEY || 
    process.env.SERVER_KEY.trim().length < KEY_MIN_LENGTH ||
    process.env.SERVER_KEY.trim().toUpperCase() == 'UNDEFINED'
  ) {
    logError(`Configuration error: Invalid SERVER_KEY. Server key either undefined or too short (${process.env.SERVER_KEY}). Min length is ${KEY_MIN_LENGTH} characters.`);
    process.exit(1);
}

// Company key validation
if( !process.env.COMPANY_KEY || 
     process.env.COMPANY_KEY.trim().length < KEY_MIN_LENGTH ||
     process.env.COMPANY_KEY.trim().toUpperCase() == 'UNDEFINED'
  ) {
    logError(`Configuration error: Invalid COMPANY_KEY. Company key is either undefined or too short (${process.env.COMPANY_KEY}). Min length is ${KEY_MIN_LENGTH} characters.`);
    process.exit(1);
}

// parameters sanity
if(process.env.MAX_PENDING_JOBS <0)
    process.env.MAX_PENDING_JOBS = 0;

if(process.env.MAX_SIMULTANEOUS_JOBS < 0)
    process.env.MAX_SIMULTANEOUS_JOBS = 0;


logInfo = (...x) => {
    if (process.env.LOG_TO_CONSOLE) {
        console.log(...x);
    }
    LOG.info(...x);
}

logError = (...x) => {
    console.error(...x);
    LOG.error(...x);
}

logDebug = (...x) => {
    if (process.env.LOG_TO_CONSOLE && process.env.LOG_VERBOSITY == 'detailed') {
        console.log(...x);
        LOG.debug(...x);
    }
}

// Body parser
app.use(bodyParser.json());
let serverUrl = new URL(process.env.APPYCENTRIC_API_URL);


/*===================================================
    Check if pending task(s) can be run
=====================================================*/
setInterval( () => {
    if (CL_SERVER_READY) {
        if (!lastTimePTLogged || moment().isSameOrAfter(moment(lastTimePTLogged).add(Number(process.env.LOG_INTERVAL), 'milliseconds'))) {
            logInfo(`Task info: - tasks in process: ${tasksInProcessing.length} of max ${process.env.MAX_SIMULTANEOUS_JOBS}, pending tasks: ${pendingTasks.length} of max ${process.env.MAX_PENDING_JOBS}, tasks in error: ${errorTasks.length}, completed tasks: ${completedTasks.length}, tasks awaiting cleanup: ${tasksForCleanup.length}.`);
            lastTimePTLogged = Date.now();
        }

        if (pendingTasks.length > 0) {
            for (let p=pendingTasks.length-1; p>=0; p--) {
                if (tasksInProcessing.length < process.env.MAX_SIMULTANEOUS_JOBS) {
                    if (pendingTasks[p].status == 'pending' && pendingTasks[p].downloadStatus == 'downloaded') {
                        pendingTasks[p].startedAt = moment().toDate();

                        // Get parameters required for job execution
                        let jobDir  = pendingTasks[p].jobDirectory;
                        let jobId   = pendingTasks[p].jobId;
                        let payload = pendingTasks[p].payloadBody ? pendingTasks[p].payloadBody : '';

                        let timeoutMs = moment(pendingTasks[p].timeout).diff(moment(), 'milliseconds');
                        pendingTasks[p].status = 'in-progress';
                        tasksInProcessing.push(pendingTasks[p]);
                        pendingTasks.splice(p, 1); // Remove from an array of pending tasks
                        
                        // Run the job
                        execJob(jobDir, jobId, timeoutMs, payload);
                    }
                }
            }
        }
    }
}, process.env.PENDING_JOBS_SYNC_INTERVAL);


/*===================================================
    Check jobs' statuses [internally]
=====================================================*/
setInterval( () => {
    if (CL_SERVER_READY && tasksInProcessing.length) {
        for (let t=0; t<tasksInProcessing.length; t++) {
            if (fs.existsSync(path.join(cwd, tasksInProcessing[t].jobDirectory, 'getJobStatus' + ext))) {
                if (tasksInProcessing[t].jobType != 'sync' && !tasksInProcessing[t].checkedStatusAt || moment().subtract(Number(process.env.MIN_JOB_STATUS_UPDATE_AGE), 'milliseconds').isSameOrAfter(moment(tasksInProcessing[t].checkedStatusAt))) {
                    // Use a job ID in order to get a status of the job
                    let jobDir = tasksInProcessing[t].jobDirectory;
                    let jobId = tasksInProcessing[t].jobId;
                    if (!tasksInProcessing[t].lastTimeStatusLogged) {
                        tasksInProcessing[t].lastTimeStatusLogged = Date.now();
                    }
                    let lastTimeStatusLogged = tasksInProcessing[t].lastTimeStatusLogged;
                    
                    // Check job status
                    checkJobStatus(jobDir, jobId, lastTimeStatusLogged);
                }
            }
        }
    }
}, process.env.JOB_STATUS_UPDATE_INTERVAL);


/*===================================================
    Update jobs' statuses - jobs "in processing"
    Call AppyCentric server
=====================================================*/
setInterval( () => {
    if (CL_SERVER_READY && tasksInProcessing.length) {        
        if (tasksInProcessing.length && !UPDATING_JOBS_STATUSES) {
            UPDATING_JOBS_STATUSES = true;
            let tasksInfo = [];
            for (let t=0; t<tasksInProcessing.length; t++) {
                if (tasksInProcessing[t].jobType != 'sync' && fs.existsSync(path.join(cwd, tasksInProcessing[t].jobDirectory, 'getJobStatus' + ext)) && tasksInProcessing[t].status == 'in-progress') {
                    tasksInfo.push({
                        'allowCancelation': fs.existsSync(path.join(cwd, tasksInProcessing[t].jobDirectory, 'cancelJob' + ext)) ? 'yes' : 'no',
                        'jobId': tasksInProcessing[t].jobId,
                        'status': tasksInProcessing[t].status,
                        'percentage': tasksInProcessing[t].percentage,
                        'info': tasksInProcessing[t].info
                    });
                }
            }

            if (tasksInfo.length > 0) {
                updateStatuses(tasksInfo, 'ok');
            }
            else {
                UPDATING_JOBS_STATUSES = false;
            }
        }
    }
}, process.env.JOB_STATUS_UPLOAD_INTERVAL);


/*===================================================
    Update error jobs' statuses
    Call AppyCentric server
=====================================================*/
setInterval( () => {
    if (CL_SERVER_READY && errorTasks.length && !UPDATING_ERROR_JOBS_STATUSES) {           
        for (let eT=0; eT<errorTasks.length; eT++) {
            if (ERROR_TASKS_IN_UPDATING < process.env.MAX_PARALLEL_JOB_ERROS_UPLOAD && 
                (!errorTasks[eT].lastAttemptionToUpdateAt || moment().subtract(Number(process.env.ERROR_JOB_STATUS_UPLOAD_RETRY_INTERVAL), 'milliseconds').isSameOrAfter(moment(errorTasks[eT].lastAttemptionToUpdateAt)))) {
                UPDATING_ERROR_JOBS_STATUSES = true;
                ++ERROR_TASKS_IN_UPDATING;
                let errorTask = {
                    'jobDirectory': errorTasks[eT].jobDirectory,
                    'jobId': errorTasks[eT].jobId,
                    'status': errorTasks[eT].status,
                    'info': errorTasks[eT].info,
                    'code': errorTasks[eT].code,
                    'erroredAt': errorTasks[eT].errorDetectedAt
                };
                
                updateErrorTaskStatus(errorTask);
                break;
            }
        }
    }
}, process.env.ERROR_JOB_STATUS_UPLOAD_INTERVAL);


/*===================================================
    Check if completed task(s) can be uploaded
    to the AppyCentric server
=====================================================*/
setInterval( () => {
    if (CL_SERVER_READY && completedTasks.length && !UPDATING_JOBS_STATUSES) {
        for (let c=0; c<completedTasks.length; c++) {
            // Logging - check for the last time logged
            if (!completedTasks[c].lastTimeCompletedTasksLogged) {
                completedTasks[c].lastTimeCompletedTasksLogged = Date.now();
            }

            if (moment().isSameOrAfter(moment(completedTasks[c].lastTimeCompletedTasksLogged).add(Number(process.env.LOG_INTERVAL), 'milliseconds'))) {
                logInfo('CHECK FOR UPLOAD... Completed task: #' + completedTasks[c].jobId + '. Completed tasks in uploading: ' + COMPLETED_TASKS_IN_UPLOADING + ', Max. parallel job results upload: ' + process.env.MAX_PARALLEL_JOB_RESULTS_UPLOAD + ', Last attemption to upload: ' + completedTasks[c].lastAttemptionToUploadAt + '. Retry interval: ' +  moment().subtract(Number(process.env.JOB_RESULTS_UPLOAD_RETRY_INTERVAL), 'milliseconds').toDate() + '. Details: ' + JSON.stringify(completedTasks[c]));
                completedTasks[c].lastTimeCompletedTasksLogged = Date.now();
            }
            
            if (completedTasks[c].status == 'completed' && COMPLETED_TASKS_IN_UPLOADING < process.env.MAX_PARALLEL_JOB_RESULTS_UPLOAD && 
            (!completedTasks[c].lastAttemptionToUploadAt || 
                moment().subtract(Number(process.env.JOB_RESULTS_UPLOAD_RETRY_INTERVAL), 'milliseconds').isSameOrAfter(moment(completedTasks[c].lastAttemptionToUploadAt)))) {
                completedTasks[c].status = 'uploading';
                // Use a job ID in order to get a status of the job
                let jobDir = completedTasks[c].jobDirectory;
                let jobId  = completedTasks[c].jobId;
                
                ++COMPLETED_TASKS_IN_UPLOADING;
                uploadTaskResults(jobDir, jobId);
            }
        }
    }
}, process.env.JOB_RESULTS_UPLOAD_INTERVAL);


/*=========================================
    Retry Download - if an error occurred
===========================================*/
setInterval( () => {
    if (CL_SERVER_READY && pendingTasks.length > 0) {
        for (let p=pendingTasks.length-1; p>=0; p--) {
            if (pendingTasks[p].downloadStatus == 'waiting' && !pendingTasks[p].downloadingInProgress && (!pendingTasks[p].downloadRetriedAt || moment().subtract(Number(process.env.JOB_TASKS_DOWNLOAD_RETRY_INTERVAL), 'milliseconds').isSameOrAfter(moment(pendingTasks[p].downloadRetriedAt)))) {   
                if (moment().isSameOrAfter(moment(pendingTasks[p].timeout))) {
                    let errorMsg = 'Timeout expired.';
                    logError(errorMsg);

                    // Push to error pool
                    errorTasks.push({'jobDirectory': '', 'jobId': jobId, 'status': 'timeout', code: 408, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(errorMsg)});
                    pendingTasks.splice(p, 1); // Remove from an array of pending tasks
                }
                else {
                    let payloadUrl = pendingTasks[p].payloadUrl;
                    let jobId      = pendingTasks[p].jobId;
                    let timeoutExp = pendingTasks[p].timeout;
                    let apiClass   = pendingTasks[p].jobDirectory;

                    let downloadOptions  = {
                        directory: pendingTasks[p].tasksDir,
                        filename: jobId + '.zip'
                    };
                    let taskDirectory       = path.join(cwd, apiClass, jobId + '-tasks');
                    let resultsDirectory    = path.join(cwd, apiClass, jobId + '-results');
                    let resultsZipDirectory = path.join(cwd, apiClass, jobId + '-results.zip');
                    
                    pendingTasks[p].downloadingInProgress = true;
                    downloadFiles(payloadUrl + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobId=' + jobId + '&timeoutExpiration=' + timeoutExp, downloadOptions, apiClass, jobId, taskDirectory, resultsDirectory, resultsZipDirectory);
                }
            }
        }
    }
}, process.env.JOB_TASKS_DOWNLOAD_INTERVAL);


/*===================================================
    Cleanup
=====================================================*/
setInterval( () => {
    if (CL_SERVER_READY && tasksForCleanup.length > 0) {
        if (tasksForCleanup.length > 0 && TASKS_IN_CLEANING_UP < process.env.MAX_PARALLEL_JOBS_CLEANUP) {
            for (let i=0; i<tasksForCleanup.length; i++) {
                if (fs.existsSync(path.join(cwd, tasksForCleanup[i].jobDirectory, 'cleanUpJob' + ext))) {
                    if (tasksForCleanup[i].status != 'cleaning-up' && TASKS_IN_CLEANING_UP < process.env.MAX_PARALLEL_JOBS_CLEANUP && (!tasksForCleanup[i].lastAttemptionToCleanup || moment().subtract(Number(process.env.CLEANUP_RETRY_INTERVAL), 'milliseconds').isSameOrAfter(moment(tasksForCleanup[i].lastAttemptionToCleanup)))) {
                        ++TASKS_IN_CLEANING_UP;
                        tasksForCleanup[i].status = 'cleaning-up';
                        logDebug("Cleaning up : " + tasksForCleanup[i].jobDirectory, " , job: ", tasksForCleanup[i].jobId);
                        doCleanup(tasksForCleanup[i].jobDirectory, tasksForCleanup[i].jobId);
                    }
                }
            }
        }
    }
}, process.env.JOB_CLEANUP_INTERVAL);


/*===================================================
    Timeout - if pending tasks are expired
=====================================================*/
setInterval( () => {
    if (CL_SERVER_READY) {
        // Remove timeout tasks from "pending" tasks pool
        if (pendingTasks.length > 0) {
            for (let i=pendingTasks.length-1; i>=0; i--) {
                if (pendingTasks[i].timeout && moment() >= moment(pendingTasks[i].timeout)) {
                    errorTasks.push({'jobId': pendingTasks[i].jobId, 'status': 'timeout', 'code': 408, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': 'Timeout'});
                    pendingTasks.splice(i, 1);
                }
            }
        }
    }
}, process.env.JOB_TIMEOUT_SYNC_INTERVAL);



/*===================================================
    Exit a child process
=====================================================*/
processChildExit = (jobProc, scriptOrigin, cmd, event, tmout, identifier, job_dir, job_id, timeoutMs, jobPayload) => {
    let executed = false;
    
    if (event == 'close') {
        let closeProessMsg = 'Process [pid]: ' + jobProc.pid ? jobProc.pid : 'N/A' + ' closed stdio... ignoring this event, but possible exit (recently or soon)...';
        logDebug(closeProessMsg);
        return;
    }
    
    if (tmout) { 
        clearTimeout(tmout);
        tmout = undefined;
    }

    if (!executed) {
        let info = '';
        if (fs.existsSync(path.join(cwd, job_dir, job_id + '-results/job.info'))) {
            info = fs.readFileSync(path.join(cwd, job_dir, job_id + '-results/job.info'), 'utf8');
        }

        let timeoutTriggered = null;
        for (let t=tasksInProcessing.length-1; t>=0; t--) {
            if (tasksInProcessing[t].jobId == job_id) {
                if (moment().isSameOrAfter(moment(tasksInProcessing[t].timeout))) {
                    timeoutTriggered = true;
                }
                break;
            }
        }
        
        // Firstly, check if a task execution timeout occurred
        if (timeoutTriggered) {
            executed = true;
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'timeout', 'code': 408, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('Internal server error [ALRJ timeout]')});
            
            let errorMsg = 'A imeout of ' + timeoutMs + ' ms triggered. Directory: "' + job_dir + ', task: #' + job_id + '.';
            logError(errorMsg);
    
            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\r' + errorMsg);
        }
        else if (identifier === 0) {
            executed = true;
            let syncInfo = scriptOrigin == 'startJob' ? ('Task: #' + job_id + ' is completed. Command: ' + cmd + '. Arguments: ' + jobPayload) : 'Task: #' + job_id + ' is completed.';
            logInfo(syncInfo);

            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    let completionDetectedAt = moment();

                    tasksInProcessing[t].checkedStatusAt = moment(completionDetectedAt).toDate();
                    tasksInProcessing[t].percentage      = 100;
                    tasksInProcessing[t].status          = 'completed';
                    tasksInProcessing[t].completedAt     = moment(completionDetectedAt).toDate();
                    
                    let completedTask = tasksInProcessing[t];
                    completedTasks.push(completedTask);
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }
            if (scriptOrigin == 'startJob') {
                fs.writeFileSync(path.join(cwd, job_dir, job_id + '-results', 'job.sync'), 'true');
            }
        }
        else if (identifier == 2) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }

            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 404, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('ALRJ server error [ALRJ files not found].')});

            let notFoundMsg = 'Internal server error. ALRJ files not found. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.';
            logError(notFoundMsg);

            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rALRJ files not found. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.');
        }
        else if (identifier == 3) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }

            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 404, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('ALRJ server error [invalid task location].')});

            let pathNotFoundMsg = 'Internal server error. An ALRJ path not found. Command: "' + cmd + '". Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.';
            logError(pathNotFoundMsg);

            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rALRJ path not found. Command: "' + cmd + '". Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.');
        }
        else if (identifier == 4) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }

            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 500, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('ALRJ server error [code-4].')});

            let tooManyOpenFilesMsg = 'Internal server error. Too many open files. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.';
            logError(tooManyOpenFilesMsg);

            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rToo many open files. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.');
        }
        else if (identifier == 5) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }

            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 403, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('ALRJ server error [access denied].')});

            let accessDeniedMsg = 'Internal server error. Access denied. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.';
            logError(accessDeniedMsg);

            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rAccess denied. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.');
        }
        else if (identifier == 6) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }
            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'canceled', 'code': 400, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('Task is canceled.')});

            let errInfo = 'Status of the task: #' + job_id + ' is "canceled". The task has been canceled.';
            logError(errInfo);
            
            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rALRJ: #' + job_id + ' canceled. Script: "' + scriptOrigin + '". Directory: ' + job_dir + '.');
        }
        else if (identifier == 7) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }
            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 404, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('Task: #' + job_id + ' not found.')});

            let errInfo = 'Task: #' + job_id + ' is not found.';
            logError(errInfo);
            
            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rTask not found. Script: "' + scriptOrigin + '". Directory: ' + job_dir + ', task: #' + job_id + '.');
        }
        else if (identifier == 8) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }
            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 400, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('ALRJ server error [code-8]')});

            let errInfo = 'Status of the task: #' + job_id + ' is "error".';
            logError(errInfo);
            
            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rALRJ error [code-8]. Script: "' + scriptOrigin + '". Directory: ' + job_dir + ', task: #' + job_id + '.');
        }
        else if (identifier == 9 || identifier == 10) {
            executed = true;
            // job was started and it will be ASYNCHRONOUSLY completed. We need to report job status
            let inProcessingInfo = 'Task: #' + job_id + ' is ' + (identifier == 9 ? 'pending' : 'in progress') + '. Code: ' + identifier + '.';
            logInfo(inProcessingInfo);

            if (fs.existsSync(path.join(cwd, job_dir, job_id + '-results')) && !fs.existsSync(path.join(cwd, job_dir, job_id + '-results', 'job.async'))) {
                fs.writeFileSync(path.join(cwd, job_dir, job_id + '-results', 'job.async'), 'true');
            }
            for (let i=0; i<tasksInProcessing.length; i++) {
                if (tasksInProcessing[i].jobId == job_id) {
                    tasksInProcessing[i].jobType = 'async';
                    break;
                }
            }
        }
        else if (identifier >= 100 && identifier <= 199) {
            let logStatusChange = false;
            for (let t=0; t<tasksInProcessing.length; t++) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing[t].checkedStatusAt = moment().toDate();
                    tasksInProcessing[t].percentage = identifier - 100;
                    tasksInProcessing[t].info = info ? info : 'N/A';
                    tasksInProcessing[t].jobType = 'async';
                    if (!tasksInProcessing[t].lastTimePercentageLogged) {
                        tasksInProcessing[t].lastTimePercentageLogged = Date.now();
                    }
                    if (moment().isSameOrAfter(moment(tasksInProcessing[t].lastTimePercentageLogged).add(Number(process.env.LOG_INTERVAL), 'milliseconds'))) {
                        logStatusChange = true;
                        tasksInProcessing[t].lastTimePercentageLogged = Date.now();
                    }
                    break;
                }
            }
            
            if (logStatusChange) {
                let inProgressMsg = scriptOrigin == 'startJob' ? ('Task: #' + job_id + ' is in progress. Completed: ' + (identifier - 100) + '%.') : ('Status of the task: #' + job_id + ' checked [internally]. The job is in progress. Completed: ' + (identifier - 100) + '%.');
                logInfo(inProgressMsg);
            }

            if (fs.existsSync(path.join(cwd, job_dir, job_id + '-results')) && !fs.existsSync(path.join(cwd, job_dir, job_id + '-results', 'job.async'))) {
                fs.writeFileSync(path.join(cwd, job_dir, job_id + '-results', 'job.async'), 'true');
            }
        }
        else if (identifier == 999) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }

            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 500, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('ALRJ server error [code-999].')});

            let scriptTimeoutMsg = 'Internal server error. A script execution timeout of ' + process.env.MAX_SCRIPT_EXECUTION_TIME + ' ms occurred. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.';
            logError(scriptTimeoutMsg);

            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rA script execution timeout of ' + process.env.MAX_SCRIPT_EXECUTION_TIME + ' ms occurred. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.');
        }
        else if (identifier == 1999) {
            executed = true;
            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }

            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': identifier, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('ALRJ server error [code-1999]')});

            let errorMsg = 'Internal server error occurred while processing script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '. A script execution timeout of ' + process.env.MAX_SCRIPT_EXECUTION_TIME + ' ms occurred, but the job process is not killed.';
            logError(errorMsg);

            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rA script execution timeout of ' + process.env.MAX_SCRIPT_EXECUTION_TIME + ' ms occurred, but the job process is not killed. Script: "' + scriptOrigin + '". Directory: "' + job_dir + ', task: #' + job_id + '.');
        }
        else {
            executed = true;
            console.log("Hendlovati ostale kodove sve... Detalji: ", identifier);
            
            let errorInfo = 'Error starting task: #' + job_id + '. Command: ' + cmd + '. Arguments: ' + jobPayload + '. Error [code]: ' + (identifier.code ? identifier.code : 'N/A') + ', error [message]: ' + (identifier.message ? identifier.message : 'N/A') + '. Details: ' + (identifier.stack ? identifier.stack : 'N/A');
            logError(errorInfo);

            // Remove from array of "in-processing" tasks
            for (let t=tasksInProcessing.length-1; t>=0; t--) {
                if (tasksInProcessing[t].jobId == job_id) {
                    tasksInProcessing.splice(t, 1);
                    break;
                }
            }
            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 500, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('Command: "' + scriptOrigin + '" failed.')});
            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rInternal server error. Script: "' + scriptOrigin + '". Directory: ' + job_dir + ', task: #' + job_id + '. Error [code]: ' + (identifier.code ? identifier.code : 'N/A') + '. Error [message]: ' + identifier.message ? identifier.message : 'N/A');
        }
    
        if (jobProc && process.env.LOG_TO_CONSOLE) {
            console.log('\n');
            console.log("Process was: ", JSON.stringify(jobProc));
            console.log('\n');
        }
    }
}

/*===================================================
    Exit a child process [cleanup/cancel]
=====================================================*/
processChildExitCommand = (jobProc, scriptOrigin, cmd, event, tmout, identifier, jobDir, jobId) => {
    let executed = false;
    
    if (event == 'close') {
        let closeProessMsg = 'Process [pid]: ' + jobProc.pid ? jobProc.pid : 'N/A' + ' closed stdio... ignoring this event, but possible exit (recently or soon)...';
        logDebug(closeProessMsg);
        return;
    }
    
    if (tmout) { 
        clearTimeout(tmout);
        tmout = undefined;
    }

    if (process.env.LOG_TO_CONSOLE) {
        console.log(`Process [cleanup or cancel]: ${jobProc.pid ? jobProc.pid : 'N/A'} terminated with event = [${event}], with code=[${identifier}], processing the code:`);
    }
    
    if (!executed) {
        if (identifier === 0 && scriptOrigin == 'cleanup') {
            executed = true;
            
            --TASKS_IN_CLEANING_UP;
            for (let cTask=tasksForCleanup.length-1; cTask>=0; cTask--) {
                if (tasksForCleanup[cTask].jobId == jobId) {
                    tasksForCleanup.splice(cTask, 1);
                    
                    let taskDirectory       = path.join(cwd, jobDir, jobId + '-tasks');
                    let resultsDirectory    = path.join(cwd, jobDir, jobId + '-results');
                    let resultsZipDirectory = path.join(cwd, jobDir, jobId + '-results.zip');
                    if (fs.existsSync(taskDirectory)) {
                        fs.rm(taskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                            if (rmErr) {
                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + jobId + '-tasks.');
                            }
                        });
                    }
                    if (fs.existsSync(resultsDirectory)) {
                        fs.rm(resultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                            if (rmErr) {
                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + jobId + '-results.');
                            }
                        });
                    }
                    if (fs.existsSync(resultsZipDirectory)) {
                        fs.rm(resultsZipDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                            if (rmErr) {
                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + jobId + '-results.zip.');
                            }
                        });
                    }

                    logInfo('Task: #' + jobId + ' is cleaned up.');
                    break;
                }
            }
        }
        else if (identifier === 0 && scriptOrigin == 'cancel') {
            executed = true;
            logInfo('Task: #' + jobId + ' cancelation is run.');
        }
        else {
            executed = true;

            // Cleanup
            if (scriptOrigin == 'cleanup') {
                --TASKS_IN_CLEANING_UP;
                for (let cTask=tasksForCleanup.length-1; cTask>=0; cTask--) {
                    if (tasksForCleanup[cTask].jobId == jobId) {
                        tasksForCleanup[cTask].retries += 1;
                        tasksForCleanup[cTask].lastAttemptionToCleanup = moment().toDate();

                        // If max retries is reached - directories will be removed
                        if (tasksForCleanup[cTask].retries >= process.env.MAX_CLEANUP_RETRIES) {
                            tasksForCleanup.splice(cTask, 1);
                            
                            let taskDirectory       = path.join(cwd, jobDir, jobId + '-tasks');
                            let resultsDirectory    = path.join(cwd, jobDir, jobId + '-results');
                            let resultsZipDirectory = path.join(cwd, jobDir, jobId + '-results.zip');
                            if (fs.existsSync(taskDirectory)) {
                                fs.rm(taskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                    if (rmErr) {
                                        fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + jobId + '-tasks.');
                                    }
                                });
                            }
                            if (fs.existsSync(resultsDirectory)) {
                                fs.rm(resultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                    if (rmErr) {
                                        fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + jobId + '-results.');
                                    }
                                });
                            }
                            if (fs.existsSync(resultsZipDirectory)) {
                                fs.rm(resultsZipDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                    if (rmErr) {
                                        fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + jobId + '-results.zip.');
                                    }
                                });
                            }
                        }
                
                        logError('Cleanup ERROR. Task: #' + jobId + '. Error [code]: ' + (identifier.code ? identifier.code : 'N/A') + '\rError [message]: ' + (identifier.message ? identifier.message : 'N/A') + '\rError [stack]: ' + (identifier.stack ? identifier.stack : 'N/A'));
                        break;
                    }
                }
            }

            // Cancel
            if (scriptOrigin == 'cancel') {
                let scriptTimeoutMsg = 'Internal server error. A script execution timeout of ' + process.env.MAX_JOB_CANCELATION_TIME + ' ms occurred. Script: "cancelJob". Directory: "' + jobDir + ', task: #' + jobId + '.';
                let excMsg = 'Internal server error occurred while processing script: "cancelJob". Directory: "' + job_dir + ', task: #' + job_id + '. A script execution timeout of ' + process.env.MAX_JOB_CANCELATION_TIME + ' ms occurred, but the job process is not killed.';
                let otherErrMsg = 'The error happened while processing script: "cancelJob". Directory: ' + jobDir + ', task: #' + jobId + '.\rError [code]: ' + (identifier.code ? identifier.code : 'N/A') + '\rError [message]: ' + (identifier.message ? identifier.message : 'N/A') + '\rError [stack]: ' + (identifier.stack ? identifier.stack : 'N/A');

                let cancelationErrorInfo = identifier == 999 ? scriptTimeoutMsg : identifier == 1999 ? excMsg : otherErrMsg;
                logError(cancelationErrorInfo);

                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\r' + cancelationErrorInfo);
            }
        }
    
        if (jobProc && process.env.LOG_TO_CONSOLE) {
            console.log('\n');
            console.log("Process was: ", JSON.stringify(jobProc));
            console.log('\n');
        }
    }
}


/*====================================
    Job execution (start job)...
======================================*/
execJob = (job_dir, job_id, timeoutMs, jsonPayload) => {
    let cmd = path.join(cwd, job_dir, 'startJob' + ext);

    let canRunScript = false;
    let jobPayload = '';
    if (jsonPayload && typeof jsonPayload == 'object' && Object.keys(jsonPayload).length > 0) {
        try {
            canRunScript = true;
            jobPayload = "'" + JSON.stringify(jsonPayload) + "'";
        }   
            catch (parsingArgvErr) {                
                let errorInfo = 'Error while parsing script arguments [before run a task]. Task: #' + job_id + '. Error [message]: ' + parsingArgvErr.message + '. Error [details]: ' + parsingArgvErr.stack;
                logError(errorInfo);

                // Remove from array of "in-processing" tasks
                for (let t=tasksInProcessing.length-1; t>=0; t--) {
                    if (tasksInProcessing[t].jobId == job_id) {
                        tasksInProcessing.splice(t, 1);
                        break;
                    }
                }
                // Add to "error tasks" array
                errorTasks.push({'jobDirectory': job_dir, 'jobId': job_id, 'status': 'error', 'code': 500, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('Command: "startJob" failed [invalid arguments].')});

                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rInternal server error. Script: "startJob". Directory: ' + job_dir + ', task: #' + job_id + '. Error [code]: ' + (parsingArgvErr.code ? parsingArgvErr.code : 'N/A') + '. Error [message]: ' + (parsingArgvErr.message ? parsingArgvErr.message : 'N/A'));
        }
    }

    if (canRunScript) {
        let childProcess = spawn(cmd, [job_id, jobPayload], {detached: true, windowsHide: true, stdio: 'ignore', cwd: cwd + slash + job_dir} );
        childProcess.unref();

        let processRunMsg = 'A process [start job] is run. Details: ' + JSON.stringify(childProcess);
        logInfo(processRunMsg);
        logInfo('Execution: ' + cmd + '. ALRJ payload: ' + jobPayload);
        
        // wait SCRIPT_TIMEOUT - after this we kill the job!
        let timeout = timeoutMs && timeoutMs < Number(process.env.MAX_SCRIPT_EXECUTION_TIME) ? timeoutMs : Number(process.env.MAX_SCRIPT_EXECUTION_TIME);
        let tmout = setTimeout(() => {
            try {
                childProcess.kill('SIGINT');
                processChildExit(childProcess, 'startJob', cmd, 'timeout', tmout, 999, job_dir, job_id, timeoutMs, jobPayload);
            } catch(e) {
                processChildExit(childProcess, 'startJob', cmd, 'cannot kill', tmout, 1999, job_dir, job_id, timeoutMs, jobPayload);
            }
        }, timeout);

        
        // capture close and exit:
        childProcess.on('close', (code) => processChildExit(childProcess, 'startJob', cmd, 'close', tmout, code, job_dir, job_id, timeoutMs, jobPayload));
        childProcess.on('exit',  (code) => processChildExit(childProcess, 'startJob', cmd, 'exit',  tmout, code, job_dir, job_id, timeoutMs, jobPayload));
        childProcess.on('error', (error) => processChildExit(childProcess, 'startJob', cmd, 'error', tmout, error, job_dir, job_id, timeoutMs, jobPayload));
    }
}


/*===========================================
    Internally - check for a job status
    by job ID
=============================================*/
checkJobStatus = (job_dir, job_id, last_time_logged) => {
    let cmd = path.join(cwd, job_dir, 'getJobStatus' + ext);
    let jobStatusChildProcess = spawn(cmd, [job_id], {detached: true, windowsHide: true, stdio: 'ignore', cwd: cwd + slash + job_dir} );
    jobStatusChildProcess.unref();

    if (!last_time_logged || moment().isSameOrAfter(moment(last_time_logged).add(Number(process.env.LOG_INTERVAL), 'milliseconds'))) {
        let processRunMsg = 'A process: "Get task status" is run internally for the task: #' + job_id + '. Execution: ' + cmd + '. Details: ' + JSON.stringify(jobStatusChildProcess);
        logInfo(processRunMsg);

        for (let t=0; t<tasksInProcessing.length; t++) {
            if (tasksInProcessing[t].jobId == job_id) {
                tasksInProcessing[t].lastTimeStatusLogged = Date.now();
                break;
            }
        }
    }

    // wait SCRIPT_TIMEOUT - after this we kill the job!
    let timeout = Number(process.env.MAX_SCRIPT_EXECUTION_TIME);
    let tmout = setTimeout(() => {
        try {
            jobStatusChildProcess.kill('SIGINT');
            processChildExit(jobStatusChildProcess, 'getJobStatus', cmd, 'timeout', tmout, 999, job_dir, job_id);
        } catch(e) {
            processChildExit(jobStatusChildProcess, 'getJobStatus', cmd, 'cannot kill', tmout, 1999, job_dir, job_id);
        }
    }, timeout);
    
    // capture close and exit:
    jobStatusChildProcess.on('close', (code) => processChildExit(jobStatusChildProcess, 'getJobStatus', cmd, 'close', tmout, code, job_dir, job_id));
    jobStatusChildProcess.on('exit',  (code) => processChildExit(jobStatusChildProcess, 'getJobStatus', cmd, 'exit', tmout, code, job_dir, job_id));
    jobStatusChildProcess.on('error', (error) => processChildExit(jobStatusChildProcess, 'getJobStatus', cmd, 'error', tmout, error, job_dir, job_id));
}


/*=============================================
    Update statuses for - jobs "in progress"
===============================================*/
updateStatuses = (jobsInfo, updatingType) => {
    let serverUrl = new URL(process.env.APPYCENTRIC_API_URL);
    let headers   = {
        'Content-Type': 'application/json'
    };

    let serverInfo = {};                          
    if (serverUrl.port) {
        serverInfo = {
            host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
            port: Number(serverUrl.port),
            path: serverUrl.pathname + (serverUrl.pathname.endsWith('/') ? 'update-statuses' : '/update-statuses') + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY,
            headers: headers,
            method: 'POST',
            rejectUnauthorized: false
        };
    } 
        else {
            serverInfo = {
                protocol: serverUrl.protocol,
                host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
                path: serverUrl.pathname + (serverUrl.pathname.endsWith('/') ? 'update-statuses' : '/update-statuses') + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY,
                headers: headers,
                method: 'POST',
                rejectUnauthorized: false
            };
        }

    // Pickup jobs' IDs
    let jobsIds = [];
    for (let i=0; i<jobsInfo.length; i++) {
        jobsIds.push('#' + jobsInfo[i].jobId);
    }

    logInfo('Non-error tasks\' statuses are being updated. ' + jobsInfo.length + ' tasks ready. [call API server]');

    let appycentricProtocol = serverUrl.protocol && serverUrl.protocol.match('https') ? https : http;
    delete serverInfo.protocol;

    const callBusinessServerUsingHttpRequest = appycentricProtocol.request(serverInfo, (response) => {
        // Response received!
        response.once('data', (d) => {
            try {
                let statusInfo = JSON.parse(d.toString());
                // AppyCentric updated ALRJs statuses
                if (statusInfo.status == 'ok') {
                    if (updatingType == 'pending') {
                        CL_SERVER_READY = true;
                        logInfo('Updated statuses of the non-error tasks. Tasks: ' + jobsIds.join(', ') + '. Details: ' + d ? d.toString() : 'N/A');
                        longPolling();
                    }
                    // Ok jobs
                    else {
                        UPDATING_JOBS_STATUSES = false;
                        logInfo('Updated statuses of the non-error tasks. Tasks: ' + jobsIds.join(', ') + '. Details: ' + d ? d.toString() : 'N/A');
                    }
                }
                    // Error occurred on the AppyCentric server
                    else {
                        UPDATING_JOBS_STATUSES = false;
                        logError('Update statuses of the non-error tasks. Tasks: ' + jobsIds.join(', ') + '. An error occurred. Details: ' + d ? d.toString() : 'N/A');
                    }
            }
                catch (e) {
                    UPDATING_JOBS_STATUSES = false;
                    logError('Update statuses of the non-error tasks. Tasks: ' + jobsIds.join(', ') + '. An exception occurred. Response details: ' + d ? d.toString() : 'N/A' + '\rError: ' + e);
                }
        });
    });
    // Error
    callBusinessServerUsingHttpRequest.on('error', (httpReqErr) => {
        if (updatingType == 'pending') {
            CL_SERVER_READY = true;
            logError('Update statuses of the non-error tasks. Tasks: ' + jobsIds.join(', ') + '. An error occurred. Details: ' + httpReqErr ? JSON.stringify(httpReqErr) : 'N/A');
            longPolling();
        }
        else {
            UPDATING_JOBS_STATUSES = false;
            logError('Update statuses of the non-error tasks. Tasks: ' + jobsIds.join(', ') + '. An error occurred. Details: ' + httpReqErr ? JSON.stringify(httpReqErr) : 'N/A');
        }
    });
    callBusinessServerUsingHttpRequest.write(JSON.stringify(jobsInfo));    
    callBusinessServerUsingHttpRequest.end();
}


/*=================================================
    Update statuses for job in "irregular" state
    (error/timeout/canceled)
===================================================*/
updateErrorTaskStatus = (jobInfo) => {
    let serverUrl = new URL(process.env.APPYCENTRIC_API_URL);
    let headers   = {
        'Content-Type': 'application/json'
    };

    let serverInfo = {};
    // logInfo('Query INFO [error job]: ' + JSON.stringify(jobInfo));

    if (serverUrl.port) {
        serverInfo = {
            host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
            port: Number(serverUrl.port),
            path: serverUrl.pathname + (serverUrl.pathname.endsWith('/') ? 'switch-status' : '/switch-status') + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobId=' + jobInfo.jobId + '&status=' + jobInfo.status + '&info=' +  jobInfo.info + '&errorCode=' + (jobInfo.code ? jobInfo.code : ''),
            headers: headers,
            method: 'GET',
            rejectUnauthorized: false
        };
    } 
        else {
            serverInfo = {
                protocol: serverUrl.protocol,
                host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
                path: serverUrl.pathname + (serverUrl.pathname.endsWith('/') ? 'switch-status' : '/switch-status') + '?companyKey=' + process.env.COMPANY_KEY  + '&serverKey=' + process.env.SERVER_KEY + '&jobId=' + jobInfo.jobId + '&status=' + jobInfo.status + '&info=' + jobInfo.info + '&errorCode=' + (jobInfo.code ? jobInfo.code : ''),
                headers: headers,
                method: 'GET',
                rejectUnauthorized: false
            };
        }
    

    let appycentricProtocol = serverUrl.protocol && serverUrl.protocol.match('https') ? https : http;
    delete serverInfo.protocol;

    logInfo('Error task: #' + jobInfo.jobId + ' status is being updated via call to the API server. Server info: ' + JSON.stringify(serverInfo) + '. Task details: ' + JSON.stringify(jobInfo));

    
    for (let e=0; e<errorTasks.length; e++) {
        if (errorTasks[e].jobId == jobInfo.jobId) {
            errorTasks[e].lastAttemptionToUpdateAt = moment();
            break;
        }
    }

    const callBusinessServerUsingHttpRequest = appycentricProtocol.request(serverInfo, (response) => {
        response.once('data', (updResData) => {
            try {
                let statusInfo = JSON.parse(updResData.toString());
                if (statusInfo.status == 'ok') {
                    for (let eT=errorTasks.length-1; eT>=0; eT--) {
                        if (errorTasks[eT].jobId == statusInfo.jobId) {
                            let status = errorTasks[eT].status;
                            let jobDir = errorTasks[eT].jobDirectory;
                            errorTasks.splice(eT, 1);
                            
                            // If a job directory does exist, try to do a cleanup. In other cases, cleanup won't be run (i.e invalid ALRJ directory triggered an error)
                            if (jobDir) {
                                if (status == 'timeout' && fs.existsSync(path.join(cwd, jobDir, 'cancelJob' + ext))) {
                                    cancelJob(jobDir, statusInfo.jobId);
                                }
                                else if (fs.existsSync(path.join(cwd, jobDir, 'cleanUpJob' + ext))) {
                                    tasksForCleanup.push({'jobDirectory': jobDir, 'jobId': statusInfo.jobId, 'retries': 0, 'lastAttemptionToCleanup': null});
                                    
                                    logInfo('Status of the error task: #' + statusInfo.jobId + ' is updated. The task is ready for clean up. Details: ' + updResData ? updResData.toString() : 'N/A');
                                }
                                else {
                                    let taskDirectory       = path.join(cwd, jobDir, statusInfo.jobId + '-tasks');
                                    let resultsDirectory    = path.join(cwd, jobDir, statusInfo.jobId + '-results');
                                    let resultsZipDirectory = path.join(cwd, jobDir, statusInfo.jobId + '-results.zip');
                                    if (fs.existsSync(taskDirectory)) {
                                        fs.rm(taskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                            if (rmErr) {
                                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + statusInfo.jobId + '-tasks.');
                                            }
                                        });
                                    }
                                    if (fs.existsSync(resultsDirectory)) {
                                        fs.rm(resultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                            if (rmErr) {
                                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + statusInfo.jobId + '-results.');
                                            }
                                        });
                                    }
                                    if (fs.existsSync(resultsZipDirectory)) {
                                        fs.rm(resultsZipDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                            if (rmErr) {
                                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + jobDir + '/' + statusInfo.jobId + '-results.zip.');
                                            }
                                        });
                                    }
                                    
                                    logInfo('Status of the error task: #' + statusInfo.jobId + ' updated. Files will be deleted. Details: ' + updResData ? updResData.toString() : 'N/A');
                                }
                                break;
                            }
                            // No job directory
                            else {
                                logInfo('Status of the error task: #' + statusInfo.jobId + ' updated. No files/directories to be removed. Details: ' + updResData ? updResData.toString() : 'N/A');
                            }
                        }
                    }
                }
                else {
                    for (let i=0; i<errorTasks.length; i++) {
                        if (errorTasks[i].jobId == jobInfo.jobId) {
                            errorTasks[i].retries += 1;
                            break;
                        }
                    }
                    
                    logError('An error occurred while updating the error task: #' + jobInfo.jobId + ' status. Details: ' + updResData ? updResData.toString() : 'N/A');
                }
                
                --ERROR_TASKS_IN_UPDATING;
                UPDATING_ERROR_JOBS_STATUSES = false;
            }
                catch (e) {
                    for (let i=0; i<errorTasks.length; i++) {
                        if (errorTasks[i].jobId == jobInfo.jobId) {
                            errorTasks[i].retries += 1;
                            break;
                        }
                    }
                    
                    --ERROR_TASKS_IN_UPDATING;
                    UPDATING_ERROR_JOBS_STATUSES = false;
                    
                    logError('An exception occurred while updating the error task: #' + jobInfo.jobId + ' status. Response details: ' + updResData ? updResData.toString() : 'N/A' + '\rError: ' + e);
                }
        });
    });
    
    // Error
    callBusinessServerUsingHttpRequest.on('error', (httpReqErr) => {        
        // Error jobs
        for (let i=0; i<errorTasks.length; i++) {
            if (errorTasks[i].jobId == jobInfo.jobId) {
                errorTasks[i].retries += 1;
                break;
            }
        }
        --ERROR_TASKS_IN_UPDATING;
        UPDATING_ERROR_JOBS_STATUSES = false;
        logError('An error occurred while updating the error task: #' + jobInfo.jobId + ' status. Details: ' + httpReqErr ? JSON.stringify(httpReqErr) : 'N/A');
    });
    callBusinessServerUsingHttpRequest.end();
}


/*==================================================
    Upload Task Results On The AppyCentric Server
    (after the task completion)
====================================================*/
uploadTaskResults = (jobDir, jobId) => {
    let uplInfo = 'UPLOAD task: #' + jobId + ' results is run.';
    logInfo(uplInfo);
    
    fs.readdir(path.join(cwd, jobDir, jobId + '-results'), (error, files) => {
        if (error) {
            // Remove from array of "completed" tasks
            for (let c=completedTasks.length-1; c>=0; c--) {
                if (completedTasks[c].jobId == jobId) {
                    completedTasks.splice(c, 1);
                    break;
                }
            }
            
            let info = '';
            if (fs.existsSync(path.join(cwd, jobDir, jobId + '-results/job.info'))) {
                info = fs.readFileSync(path.join(cwd, jobDir, jobId + '-results/job.info'), 'utf8');
            }

            // Add to "error tasks" array
            errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': error.code, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('An error occurred while uploading task: #' + jobId + ' results [reading results directory].')});
            --COMPLETED_TASKS_IN_UPLOADING;

            logError('UPLOAD task results ERROR. Task: #' + jobId + '. The error happened while reading upload directory. Code: ' + error.code + ', info: ' + error.message + '. Task details: ' + info + '.');
        }
        else {
            let info = '';
            if (fs.existsSync(path.join(cwd, jobDir, jobId + '-results/job.info'))) {
                info = fs.readFileSync(path.join(cwd, jobDir, jobId + '-results/job.info'), 'utf8');
            }

            if (files.length == 0) {
                // Remove from array of "completed" tasks
                for (let c=completedTasks.length-1; c>=0; c--) {
                    if (completedTasks[c].jobId == jobId) {
                        completedTasks.splice(c, 1);
                        break;
                    }
                }
                // Add to "error tasks" array
                errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': 404, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(info)});
                --COMPLETED_TASKS_IN_UPLOADING;
                
                logError('UPLOAD task results ERROR. Task: #' + jobId + '. No files for upload.');
            }
            else {                
                let form = new FormData(); // Define form data

                for (let c=completedTasks.length-1; c>=0; c--) {
                    if (completedTasks[c].jobId == jobId) {
                        let payloadInfo = {'receivedAt': completedTasks[c].receivedAt, 'downloadedAt': completedTasks[c].downloadedAt, 'startedAt': completedTasks[c].startedAt, 'completedAt': completedTasks[c].completedAt, 'info': info};
                        form.append('payload_info', JSON.stringify(payloadInfo));
                    }
                }

                for (let f=0; f<files.length; f++) {
                    if (files[f] == 'job.info' || files[f] == 'job.status' || files[f] == 'job.cancel' || files[f] == 'job.timeout' || files[f] == 'job.sync' || files[f] == 'job.async') {
                        if (fs.existsSync(path.join(cwd, jobDir, jobId + '-results/', files[f]))) {
                            fs.unlinkSync(path.join(cwd, jobDir, jobId + '-results/', files[f]));
                        }
                    }
                }

                zipResults(path.join(cwd, jobDir, jobId + '-results'), path.join(cwd, jobDir, jobId + '-results.zip'), jobId);
                async function zipResults(currentDir, zippedDir, jobId) {
                    try {
                        if (!fs.existsSync(path.join(cwd, jobDir, jobId + '-results.zip'))) {
                            let runZipAt = moment();
                            await zip(currentDir, zippedDir);
                            let zippedAfter = moment().diff(moment(runZipAt), 'milliseconds');
                            logInfo('Task: #' + jobId + ' compression completed in ' + zippedAfter + ' ms.');
                        }
                            else {
                                logInfo('Task: #' + jobId + ' already has already compressed before.');
                            }

                        form.append('files[]', fs.createReadStream(path.join(cwd, jobDir, jobId + '-results.zip')));

                        let serverInfo = {};
                        if (serverUrl.port) {
                            serverInfo = {
                                host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
                                port: Number(serverUrl.port),
                                method: 'POST',
                                path: serverUrl.pathname + (serverUrl.pathname.endsWith('/') ? 'upload-results?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobDirectory=' + jobDir + '&jobId=' + jobId : '/upload-results?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobDirectory=' + jobDir + '&jobId=' + jobId),
                                headers: form.getHeaders(),
                                rejectUnauthorized: false
                            };
                        } 
                            else {
                                serverInfo = {
                                    protocol: serverUrl.protocol,
                                    host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
                                    path: serverUrl.pathname + (serverUrl.pathname.endsWith('/') ? 'upload-results?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobDirectory=' + jobDir + '&jobId=' + jobId : '/upload-results?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobDirectory=' + jobDir + '&jobId=' + jobId),
                                    method: 'POST',
                                    headers: form.getHeaders(),
                                    rejectUnauthorized: false
                                };
                            }
                        
                        let appycentricProtocol = serverUrl.protocol && serverUrl.protocol.match('https') ? https : http;
                        delete serverInfo.protocol;

                        let uploadStartedAt = Date.now();
                        const rq = appycentricProtocol.request(serverInfo, (response) => {
                            response.once('data', (d) => {
                                try {
                                    let apcResponse = JSON.parse(d.toString());
                                    if (apcResponse.status && apcResponse.info && apcResponse.jobDirectory && apcResponse.jobId && apcResponse.serverKey) {
                                        if (apcResponse.status == 'error') {
                                            if (apcResponse.errorType && apcResponse.errorType == 'stop') {
                                                // Remove from array of "completed" tasks
                                                for (let c=completedTasks.length-1; c>=0; c--) {
                                                    if (completedTasks[c].jobId == jobId) {
                                                        completedTasks.splice(c, 1);
                                                        break;
                                                    }
                                                }
                                                // Add to "error tasks" array
                                                errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': 403, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(apcResponse.info ? apcResponse.info : 'UPLOAD task results ERROR. Task: #' + jobId + '. The error occurred on the AppyCentric server.')});
                                                --COMPLETED_TASKS_IN_UPLOADING;
                                                
                                                logError('UPLOAD task results ERROR. Task: #' + jobId + ' files size limit has been exceeded. Details: ' + apcResponse.info);
                                            }
                                            else {
                                                logError('UPLOAD task results ERROR. Task: #' + jobId + '. The error occurred on the AppyCentric server. Info: ' + apcResponse.info + '.');

                                                for (let c=completedTasks.length-1; c>=0; c--) {
                                                    if (completedTasks[c].jobId == apcResponse.jobId) {
                                                        if (completedTasks[c].retries >= Number(process.env.MAX_RESULTS_UPLOAD_RETRIES)) {
                                                            completedTasks.splice(c, 1); // Remove from array of "completed" tasks

                                                            // Add to "error tasks" array
                                                            errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': 403, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('UPLOAD task results error.')});
                                                            --COMPLETED_TASKS_IN_UPLOADING;
                                                            logError('UPLOAD task results ERROR. Reached max. upload retries. Task: #' + jobId + '.');
                                                        }
                                                        else {
                                                            completedTasks[c].retries += 1;
                                                            completedTasks[c].status = 'completed';
                                                            completedTasks[c].lastAttemptionToUploadAt = moment(uploadStartedAt).toDate();
                                                        }
                                                        break;
                                                    }
                                                }
                                                --COMPLETED_TASKS_IN_UPLOADING;
                                            }
                                        }
                                        else {
                                            for (let c=completedTasks.length-1; c>=0; c--) {
                                                if (completedTasks[c].jobId == apcResponse.jobId) {
                                                    completedTasks.splice(c, 1);
                                                    break;
                                                }
                                            }
                                            --COMPLETED_TASKS_IN_UPLOADING;

                                            if (fs.existsSync(path.join(cwd, apcResponse.jobDirectory, '/cleanUpJob' + ext))) {
                                                tasksForCleanup.push({'jobDirectory': apcResponse.jobDirectory, 'jobId': apcResponse.jobId, 'retries': 0, 'lastAttemptionToCleanup': null});
                                                
                                                logInfo('UPLOADED task results. Task: #' + jobId + '. Files are ready for clean up. Details: ' + apcResponse ? JSON.stringify(apcResponse) : 'N/A');
                                            }
                                            else {
                                                let taskDirectory       = path.join(cwd, apcResponse.jobDirectory, apcResponse.jobId + '-tasks');
                                                let resultsDirectory    = path.join(cwd, apcResponse.jobDirectory, apcResponse.jobId + '-results');
                                                let resultsZipDirectory = path.join(cwd, apcResponse.jobDirectory, apcResponse.jobId + '-results.zip');
                                                if (fs.existsSync(taskDirectory)) {
                                                    fs.rm(taskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                                        if (rmErr) {
                                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + apcResponse.jobDirectory + '/' + jobId + '-tasks.');
                                                        }
                                                    });
                                                }
                                                if (fs.existsSync(resultsDirectory)) {
                                                    fs.rm(resultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                                        if (rmErr) {
                                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + apcResponse.jobDirectory + '/' + jobId + '-results.');
                                                        }
                                                    });
                                                }
                                                if (fs.existsSync(resultsZipDirectory)) {
                                                    fs.rm(resultsZipDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                                        if (rmErr) {
                                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError deleting directory: ' + apcResponse.jobDirectory + '/' + jobId + '-results.zip.');
                                                        }
                                                    });
                                                }
                                                
                                                logInfo('UPLOAD task results [no cleanup]. Task: #' + jobId + '. Details: ' + apcResponse ? JSON.stringify(apcResponse) : 'N/A');
                                            }
                                        }
                                    }
                                    else {
                                        logInfo('UPLOAD task results unexpected ERROR. Task: #' + jobId + '. Response details: ' + d ? d.toString() : 'N/A' + '.\rError: ' + e);
                                        for (let c=completedTasks.length-1; c>=0; c--) {
                                            if (completedTasks[c].jobId == jobId) {
                                                if (completedTasks[c].retries >= Number(process.env.MAX_RESULTS_UPLOAD_RETRIES)) {
                                                    completedTasks.splice(c, 1); // Remove from array of "completed" tasks

                                                    // Add to "error tasks" array
                                                    errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': 403, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('UPLOAD task results error.')});
                                                    --COMPLETED_TASKS_IN_UPLOADING;
                                                    
                                                    logError('UPLOAD task results ERROR. Reached max. upload retries. Task: #' + jobId + '.');
                                                }
                                                else {
                                                    completedTasks[c].retries += 1;
                                                    completedTasks[c].status = 'completed';
                                                    completedTasks[c].lastAttemptionToUploadAt = moment(uploadStartedAt).toDate();
                                                }
                                                break;
                                            }
                                        }
                                        --COMPLETED_TASKS_IN_UPLOADING;
                                    }
                                }
                                    catch (e) {
                                        logError('UPLOAD task results EXCEPTION. Task: #' + jobId + '. Response details: ' + d ? d.toString() : 'N/A' + '\rError: ' + e);
                                        for (let c=completedTasks.length-1; c>=0; c--) {
                                            if (completedTasks[c].jobId == jobId) {
                                                if (completedTasks[c].retries >= Number(process.env.MAX_RESULTS_UPLOAD_RETRIES)) {
                                                    completedTasks.splice(c, 1); // Remove from array of "completed" tasks

                                                    // Add to "error tasks" array
                                                    errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': 403, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('UPLOAD task results error.')});
                                                    --COMPLETED_TASKS_IN_UPLOADING;
                                                    
                                                    logError('UPLOAD task results ERROR. Reached max. upload retries. Task: #' + jobId + '.');
                                                }
                                                else {
                                                    completedTasks[c].retries += 1;
                                                    completedTasks[c].status = 'completed';
                                                    completedTasks[c].lastAttemptionToUploadAt = moment(uploadStartedAt).toDate();
                                                }
                                                break;
                                            }
                                        }
                                        --COMPLETED_TASKS_IN_UPLOADING;
                                    }
                            });
                        });
                        rq.on('error', (e) => {
                            logError('UPLOAD task results ERROR. Task: #' + jobId + '. Details: ' + e ? e : 'N/A');
                            for (let c=completedTasks.length-1; c>=0; c--) {
                                if (completedTasks[c].jobId == jobId) {
                                    if (completedTasks[c].retries >= Number(process.env.MAX_RESULTS_UPLOAD_RETRIES)) {
                                        completedTasks.splice(c, 1); // Remove from array of "completed" tasks

                                        // Add to "error tasks" array
                                        errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': 403, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('UPLOAD task results error.')});
                                        --COMPLETED_TASKS_IN_UPLOADING;
                                        
                                        logError('UPLOAD task results ERROR. Reached max. upload retries. Task: #' + jobId + '.');
                                    }
                                    else {
                                        completedTasks[c].retries += 1;
                                        completedTasks[c].status = 'completed';
                                        completedTasks[c].lastAttemptionToUploadAt = moment(uploadStartedAt).toDate();
                                    }
                                    break;
                                }
                            }
                            --COMPLETED_TASKS_IN_UPLOADING;
                        })
                        form.pipe(rq)
                    }
                    catch (zipError) {
                        // Remove from array of "completed" tasks
                        for (let c=completedTasks.length-1; c>=0; c--) {
                            if (completedTasks[c].jobId == jobId) {
                                completedTasks.splice(c, 1);
                                break;
                            }
                        }
                        // Add to "error tasks" array
                        errorTasks.push({'jobDirectory': jobDir, 'jobId': jobId, 'status': 'error', 'code': 403, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(apcResponse.info ? apcResponse.info : 'UPLOAD task results ERROR. Task: #' + jobId + '. The error occurred while zipping task results.')});
                        --COMPLETED_TASKS_IN_UPLOADING;
                        
                        logError('UPLOAD task results ERROR. Task: #' + jobId + '. The error occurred while zipping task results. Details: ' + zipError);
                    }
                }
            }
        }
    });
}


/*======================================
    Cancel a job
========================================*/
cancelJob = (jobDir, jobId) => {
    let cmd = path.join(cwd, jobDir, 'cancelJob' + ext);
    let cancelJobChildProcess = spawn(cmd, [jobId], {detached: true, windowsHide: true, stdio: 'ignore', cwd: cwd + slash + jobDir} );
    cancelJobChildProcess.unref();

    let processRunMsg = 'Task #' + jobId + ' cancellation attempt in progress. Execution: ' + cmd + '. Details: ' + JSON.stringify(cancelJobChildProcess);
    logInfo(processRunMsg);

    // wait SCRIPT_TIMEOUT - after this we kill the job!
    let timeout = Number(process.env.MAX_JOB_CANCELATION_TIME);
    let tmout = setTimeout(() => {
        try {
            cancelJobChildProcess.kill('SIGINT');
            processChildExitCommand(cancelJobChildProcess, 'cancel', cmd, 'timeout', tmout, 999, jobDir, jobId);
        } catch(e) {
            processChildExitCommand(cancelJobChildProcess, 'cancel', cmd, 'cannot kill', tmout, 1999, jobDir, jobId);
        }
    }, timeout);

    // capture close and exit:
    cancelJobChildProcess.on('close', (code) => processChildExitCommand(cancelJobChildProcess, 'cancel', cmd, 'close', tmout, code, jobDir, jobId));
    cancelJobChildProcess.on('exit',  (code) => processChildExitCommand(cancelJobChildProcess, 'cancel', cmd, 'exit', tmout, code, jobDir, jobId));
    cancelJobChildProcess.on('error', (error) => processChildExitCommand(cancelJobChildProcess, 'cancel', cmd, 'error', tmout, error, jobDir, jobId));
    
}


/*====================================
    Cleanup job by job ID
======================================*/
doCleanup = (jobDir, jobId) => {    
    let cmd = path.join(cwd, jobDir, 'cleanUpJob' + ext);
    let cleanupJobChildProcess = spawn(cmd, [jobId], {detached: true, windowsHide: true, stdio: 'ignore', cwd: cwd + slash + jobDir} );
    cleanupJobChildProcess.unref();
    
    let processRunMsg = 'A process [cleanup] for: ' + jobDir + '/' + jobId + ' is run. Execution: ' + cmd + '. Details: ' + JSON.stringify(cleanupJobChildProcess);
    logInfo(processRunMsg);

    // wait SCRIPT_TIMEOUT - after this we kill the job!
    let timeout = Number(process.env.MAX_SCRIPT_EXECUTION_TIME);
    let tmout = setTimeout(() => {
        try {
            cleanupJobChildProcess.kill('SIGINT');
            processChildExitCommand(cleanupJobChildProcess, 'cleanup', cmd, 'timeout', tmout, 999, jobDir, jobId);
        } catch(e) {
            processChildExitCommand(cleanupJobChildProcess, 'cleanup', cmd, 'cannot kill', tmout, 1999, jobDir, jobId);
        }
    }, timeout);

    // capture close and exit:
    cleanupJobChildProcess.on('close', (code) => processChildExitCommand(cleanupJobChildProcess, 'cleanup', cmd, 'close', tmout, code, jobDir, jobId));
    cleanupJobChildProcess.on('exit',  (code) => processChildExitCommand(cleanupJobChildProcess, 'cleanup', cmd, 'exit', tmout, code, jobDir, jobId));
    cleanupJobChildProcess.on('error', (error) => processChildExitCommand(cleanupJobChildProcess, 'cleanup', cmd, 'error', tmout, error, jobDir, jobId));
    
}


/*====================================
    Intro - return mini help
======================================*/
app.get('/getInfo', (req, res) => {
    res.header('Content-Type', 'application/json');

    RET_PING.pending      = pendingTasks.length;
    RET_PING.inProcessing = tasksInProcessing.length;
    RET_PING.completed    = completedTasks.length;
    res.json(RET_PING);
});



/*========================================
    Long Polling
==========================================*/
let longPolling = () => {
    let serverUrl = new URL(process.env.APPYCENTRIC_ADMIN_URL);
    let headers   = {
        'Content-Type': 'application/json'
    };

    let pendingJobs = '';
    for (let i=0; i<pendingTasks.length; i++) {
        pendingJobs += i==0 ? pendingTasks[i].jobId : (',' + pendingTasks[i].jobId);
    }
    let simultJobs = '';
    for (let i=0; i<tasksInProcessing.length; i++) {
        simultJobs += i==0 ? tasksInProcessing[i].jobId : (',' + tasksInProcessing[i].jobId);
    }

    let serverInfo = {};                          
    if (serverUrl.port) {
        serverInfo = {
            host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
            port: Number(serverUrl.port),
            path: serverUrl.pathname + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&pendingJobs=' + pendingJobs + '&jobsInProcessing=' + simultJobs,
            headers: headers,
            method: 'GET',
            rejectUnauthorized: false
        };
    } 
        else {
            serverInfo = {
                protocol: serverUrl.protocol,
                host: 'www.' + serverUrl.hostname, // 'appshowcase.online',
                path: serverUrl.pathname + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&pendingJobs=' + pendingJobs + '&jobsInProcessing=' + simultJobs,
                headers: headers,
                method: 'GET',
                rejectUnauthorized: false
            };
        }

    let appycentricProtocol = serverUrl.protocol && serverUrl.protocol.match('https') ? https : http;
    delete serverInfo.protocol;

    const alrjServerReq = appycentricProtocol.request(serverInfo, (response) => {
        let sResponse = '';
        response.on('data', (updResData) => {
            sResponse += updResData.toString();
        });
        response.on('end', () => {        
            try {
                let results = null;
                try {
                    results = JSON.parse(sResponse);
                }
                    catch (e) {
                        results = {invalidResponse: true, logInfo: 'An invalid response received by Web server. Details: ' + sResponse, userInfo: encodeURIComponent('An invalid request content is received by web server.')};
                    }

                if (results && results.invalidResponse) {
                    let delay = setTimeout( () => {
                        longPolling();
                        clearTimeout(delay);
                    }, 5000);

                    logError('Long polling ERROR. ' + results.logInfo);
                }
                else if (results && results.timeoutTriggered) {
                    if (!lastTimeNewTasksStatusLogged || moment().isSameOrAfter(moment(lastTimeNewTasksStatusLogged).add(Number(process.env.LOG_INTERVAL), 'milliseconds'))) {
                        logInfo('No new tasks for this server now.');
                        lastTimeNewTasksStatusLogged = Date.now();
                    }
                    longPolling();
                }
                else if (results && results.error) {
                    let delay = setTimeout( () => {
                        longPolling();
                        clearTimeout(delay);
                    }, 5000);

                    logError('Long polling ERROR. Details: ' + results.error);
                }
                else if (results && results.cancelationRequired) {
                    if (!results.cancelJobId) {
                        let delay = setTimeout( () => {
                            longPolling();
                            clearTimeout(delay);
                        }, 5000);

                        logError('Cancellation request: No Job ID specified - ignored.');
                    }
                    else {
                        let jobId = results.cancelJobId;
                        let author = results.cancelationAuthor;

                        if (pendingTasks.length > 0) {
                            for (let i=pendingTasks.length-1; i>=0; i--) {
                                if (pendingTasks[i].jobId == jobId) {
                                    let apiClass = pendingTasks[i].jobDirectory;

                                    if (!fs.existsSync(path.join(cwd, apiClass, '/cancelJob' + ext))) {
                                        let delay = setTimeout( () => {
                                            longPolling();
                                            clearTimeout(delay);
                                        }, 5000);
                                        
                                        logInfo('Cancellation request: Cancellation is not implemented. Task: #' + jobId + ', API class: ' + apiClass + '.');
                                        return res.json(RET_NO_CANCELATION);
                                    }
                                    else {
                                        pendingTasks.splice(i, 1);
                                        errorTasks.push({'jobDirectory': apiClass, 'jobId': jobId, 'status': 'canceled', code: 400, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': author == 'admin' ? encodeURIComponent('Canceled by system user') : author == 'user' ? encodeURIComponent('Canceled by user') : author == 'admin' ? encodeURIComponent('Canceled by admin') : encodeURIComponent('N/A')});
                                        
                                        logInfo('Cancellation request received. Task: #' + jobId + '. API class: ' + apiClass + '.');
                                    }
                                    break;
                                }
                            }
                        }
                        if (tasksInProcessing.length > 0) {
                            for (let i=tasksInProcessing.length-1; i>=0; i--) {
                                if (tasksInProcessing[i].jobId == jobId) {
                                    let apiClass = tasksInProcessing[i].jobDirectory;

                                    if (!fs.existsSync(path.join(cwd, apiClass, '/cancelJob' + ext))) {
                                        let delay = setTimeout( () => {
                                            longPolling();
                                            clearTimeout(delay);
                                        }, 5000);
                                        
                                        logInfo('Cancellation request: Cancellation is not implemented. Task: #' + jobId + ', API class: ' + apiClass + '.');
                                        return res.json(RET_NO_CANCELATION);
                                    }
                                    else {
                                        logInfo('Cancellation request received. Task: #' + jobId + ' will be requested to gracefully cancel. API class: ' + apiClass + '.');
                                        cancelJob(apiClass, jobId);
                                        break;
                                    }
                                }
                            }
                        }

                        // Send a new "long-polling" request
                        longPolling();
                    }
                }
                else {
                    let apiClass    = results.apiClass ? results.apiClass.trim() : null;
                    let key         = results.key ? results.key.trim() : null;
                    let jobId       = results.jobId ? results.jobId.trim() : null;
                    let payloadUrl  = results.payloadUrl ? results.payloadUrl.trim() : '';
                    let payloadBody = results.payloadBody ? results.payloadBody : null;
                    let timeoutExp  = results.alrjTimeout ? Number(results.alrjTimeout) : null;

                    logInfo(`Request log: Server key: ${key}, ALRJ class: ${apiClass}, ALRJ Job ID: ${jobId}, Payload URL: ${payloadUrl}, Payload body: ${JSON.stringify(payloadBody)}, Expiration: ${moment(timeoutExp).toDate()}`);

                    if (!jobId) {
                        let errorMsg = 'ALRJ Job ID is not provided (not received by web server).';
                        logError(errorMsg);

                        setTimeout( () => {
                            longPolling();
                        }, 5000);
                    }
                    else if (!key || key != process.env.SERVER_KEY) {
                        let errorMsg = 'An invalid business server key. Business server key [received by web server]: ' + key;
                        logError(errorMsg);
                        
                        if (jobId) {
                            // Push to error pool
                            errorTasks.push({'jobDirectory': '', 'jobId': jobId, 'status': 'error', code: 412, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('An invalid business server key.')});
                        }
                        setTimeout( () => {
                            longPolling();
                        }, 5000);
                    }
                    else if (!apiClass) {
                        let errorMsg = 'ALRJ class/directory missing.';
                        logError(errorMsg);

                        // Push to error pool
                        errorTasks.push({'jobDirectory': '', 'jobId': jobId, 'status': 'error', code: 412, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(errorMsg)});
                        setTimeout( () => {
                            longPolling();
                        }, 5000);
                    }
                    if (!fs.existsSync(path.join(cwd, apiClass))) {
                        let errorMsg =  {userInfo: 'An invalid ALRJ class: ' + apiClass + ' [received by web server].', logInfo: 'An invalid ALRJ class: ' + apiClass + ' [received by web server]. Directory with the given name does not exist.'};
                        logError(errorMsg.logInfo);
                        
                        // Push to error pool
                        errorTasks.push({'jobDirectory': '', 'jobId': jobId, 'status': 'error', code: 412, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(errorMsg.userInfo)});
                        setTimeout( () => {
                            longPolling();
                        }, 5000);
                    }
                    else if (!timeoutExp) {
                        let errorMsg = 'Timeout expiration not provided (not received by web server).';
                        logError(errorMsg);

                        // Push to error pool
                        errorTasks.push({'jobDirectory': '', 'jobId': jobId, 'status': 'error', code: 412, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(errorMsg)});
                        setTimeout( () => {
                            longPolling();
                        }, 5000);
                    }
                    else if (moment().isSameOrAfter(moment(timeoutExp))) {
                        let errorMsg = 'Timeout expired.';
                        logError(errorMsg);

                        // Push to error pool
                        errorTasks.push({'jobDirectory': '', 'jobId': jobId, 'status': 'timeout', code: 408, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent(errorMsg)});
                        setTimeout( () => {
                            longPolling();
                        }, 5000);
                    }
                    else if ((pendingTasks.length + tasksInProcessing.length) >= (parseInt(process.env.MAX_PENDING_JOBS) + process.env.MAX_SIMULTANEOUS_JOBS)) {
                        let msg = 'Server full capacities reached. Pending tasks: ' + pendingTasks.length + ', simultaneous tasks: ' + tasksInProcessing.length + '.';
                        logDebug(msg);

                        setTimeout( () => {
                            longPolling();
                        }, 5000);
                    }
                    else {
                        let jobIsAlreadyLoaded = false;
                        for (let pT=0; pT<pendingTasks.length; pT++) {
                            if (pendingTasks[pT].job_id == jobId) {
                                jobIsAlreadyLoaded = true;
                                break;
                            }
                        }
                        for (let t=0; t<tasksInProcessing.length; t++) {
                            if (tasksInProcessing[t].job_id == jobId) {
                                jobIsAlreadyLoaded = true;
                                break;
                            }
                        }

                        if (jobIsAlreadyLoaded) {
                            let msg = 'ALRJ job: #' + jobId + ' is already pending (or in-processing).';
                            logDebug(msg);
                            longPolling();
                        }
                        else {
                            let taskInfo = {'jobDirectory': apiClass, 'jobId': jobId, 'status': 'pending', 'jobType': '', 'percentage': 0, 'timeout': timeoutExp, 'checkedStatusAt': null, 'downloadStatus': 'waiting', 'info': '', 'payloadUrl': payloadUrl, 'payloadBody': payloadBody, 'tasksDir': jobId + '-tasks', 'resultsDir': jobId + '-results', 'receivedAt': Date.now(), 'downloadedAt': null, 'startedAt': null, 'completedAt': null, 'lastAttemptionToUploadAt': null, 'downloadingInProgress': false, 'downloadRetries': 0, 'downloadRetriedAt': null, 'retries': 0};
                            pendingTasks.push(taskInfo);

                            // Continue with preparing - create directories for a task (which is going to be downloaded) and task results (which will be uploaded on the Appycentric Server)
                            let taskDirectory       = path.join(cwd, apiClass, jobId + '-tasks');
                            let resultsDirectory    = path.join(cwd, apiClass, jobId + '-results');
                            let resultsZipDirectory = path.join(cwd, apiClass, jobId + '-results.zip');
                            
                            if (!fs.existsSync(taskDirectory)) {
                                fs.mkdirSync(taskDirectory);
                            }
                            if (!fs.existsSync(resultsDirectory)) {
                                fs.mkdirSync(resultsDirectory);
                            }
                            fs.writeFileSync(resultsDirectory + '/job.timeout', timeoutExp.toString());

                            // If the job contains file(s)
                            if (payloadUrl) {                
                                let downloadOptions  = {
                                    directory: taskDirectory,
                                    filename: jobId + '.zip'
                                }
                                taskInfo.downloadingInProgress = true;
                                
                                if (!payloadUrl.includes('.zip')) {
                                    downloadFiles(payloadUrl + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobId=' + jobId + '&timeoutExpiration=' + timeoutExp + '&noFiles=true', downloadOptions, apiClass, jobId, taskDirectory, resultsDirectory, resultsZipDirectory);
                                }
                                else {
                                    downloadFiles(payloadUrl + '?companyKey=' + process.env.COMPANY_KEY + '&serverKey=' + process.env.SERVER_KEY + '&jobId=' + jobId + '&timeoutExpiration=' + timeoutExp + '&noFiles=false', downloadOptions, apiClass, jobId, taskDirectory, resultsDirectory, resultsZipDirectory);
                                }
                            }
                                else {
                                    for (let pT=0; pT<pendingTasks.length; pT++) {
                                        if (pendingTasks[pT].jobId == taskInfo.jobId) {
                                            pendingTasks[pT].downloadStatus = 'downloaded';
                                            pendingTasks[pT].downloadedAt = Date.now();
                                            pendingTasks[pT].downloadingInProgress = false;
                                            break;
                                        }
                                    }
                                }
                            
                            longPolling();
                        }       
                    }
                }
            }
            catch (e) {
                let delay = setTimeout( () => {
                    longPolling();
                    clearTimeout(delay);
                }, 5000);

                logError(`Long polling EXCEPTION.  Details: ${e.message}.\n${e.stack}\nOriginal response:\n${sResponse}`);
            }
        })
    });
    
    // Error
    alrjServerReq.on('error', (httpReqErr) => {
        let delay = setTimeout( () => {
            longPolling();
            clearTimeout(delay);
        }, 5000);

        logError('Long polling ERROR. Details: ' + httpReqErr);
    });
    alrjServerReq.end();
};


/*=======================================
    Download Files From AppyCentric
=========================================*/
downloadFiles = (url, opts, jobDir, jobId, taskDirectory, resultsDirectory, resultsZipDirectory) => {
    download(url, opts, (err) => {
        if (err) {
            let targetJob = null;           
            for (let t=0; t<pendingTasks.length; t++) {
                if (pendingTasks[t].jobId == jobId) {
                    targetJob = pendingTasks[t];
                    break;
                }
            }

            logInfo('Task: #' + jobId + ' files download attemptions: ' + targetJob.downloadRetries + '. Max. download retries: '+  process.env.MAX_TASKS_DOWNLOAD_RETRIES);
            
            if (targetJob.downloadRetries < process.env.MAX_TASKS_DOWNLOAD_RETRIES) {
                targetJob.downloadRetries      += 1;
                targetJob.downloadRetriedAt     = moment().toDate();
                targetJob.downloadingInProgress = false;
                
                logError('Download client files ERROR. Task: #' + jobId + '. Download retried ' + targetJob.downloadRetries + ' times.  Details: ' + err);
            }
            else {
                if (fs.existsSync(taskDirectory)) {
                    fs.rm(taskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                        if (rmErr) {
                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + jobDir + '/' + jobId + '-tasks.');
                        }
                    });
                }
                if (fs.existsSync(resultsDirectory)) {
                    fs.rm(resultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                        if (rmErr) {
                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + jobDir + '/' + jobId + '-results.');
                        }
                    });
                }
                // Remove from array of "pending" tasks
                for (let t=pendingTasks.length-1; t>=0; t--) {
                    if (pendingTasks[t].jobId == jobId) {
                        pendingTasks.splice(t, 1);
                        break;
                    }
                }
                // Add to "error tasks" array
                errorTasks.push({'jobId': jobId, 'status': 'error', code: err.code, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('Internal error [downloading payload from AppyCentric]')});
                
                logError('Download client files ERROR. Task: #' + jobId + '.  Details: ' + err);
            }
        }
        else {
            if (url.includes('noFiles=true')) {
                logInfo('Task: #' + jobId + ' has no files. This task is ready for processing.');
                for (let pT=0; pT<pendingTasks.length; pT++) {
                    if (pendingTasks[pT].jobId == jobId) {
                        pendingTasks[pT].downloadStatus = 'downloaded';
                        pendingTasks[pT].downloadedAt = Date.now();
                        pendingTasks[pT].downloadingInProgress = false;
                        break;
                    }
                }
            }
            else {
                extractFile();
                async function extractFile() {
                    try {
                        // Unzip
                        let startExtractingTime = moment();
                        await unzip(taskDirectory + '/' + jobId + '.zip', {dir: taskDirectory});

                        let extractedAfter = moment().diff(moment(startExtractingTime), 'milliseconds');
                        logInfo('Task: #' + jobId + ' extraction completed in ' + extractedAfter + ' ms.');

                        // Remove "zip" file
                        let startRemoveTime = moment();
                        if (fs.existsSync(taskDirectory + '/' + jobId + '.zip')) {
                            fs.unlinkSync(taskDirectory + '/' + jobId + '.zip');
                        }
                        let removedAfter = moment().diff(moment(startRemoveTime), 'milliseconds');
                        
                        logInfo('Task: #' + jobId + ' zip file deleted in ' + removedAfter + ' ms.');

                        for (let pT=0; pT<pendingTasks.length; pT++) {
                            if (pendingTasks[pT].jobId == jobId) {
                                pendingTasks[pT].downloadStatus = 'downloaded';
                                pendingTasks[pT].downloadedAt = Date.now();
                                pendingTasks[pT].downloadingInProgress = false;
                                break;
                            }
                        }
                    } 
                        catch (extractingError) {
                            let targetJob = null;           
                            for (let t=0; t<pendingTasks.length; t++) {
                                if (pendingTasks[t].jobId == jobId) {
                                    targetJob = pendingTasks[t];
                                    break;
                                }
                            }

                            if (targetJob.downloadRetries < process.env.MAX_TASKS_DOWNLOAD_RETRIES) {
                                targetJob.downloadRetries      += 1;
                                targetJob.downloadRetriedAt     = moment().toDate();
                                targetJob.downloadingInProgress = false;
                                
                                logError('Download client files ERROR [extracting]. Task: #' + jobId + '. Code: ' + extractingError.code + ', error message: ' + extractingError.message + '. Details: ' + extractingError);
                            }
                            else {
                                logError('Error [extracting]: ', extractingError);

                                if (fs.existsSync(taskDirectory)) {
                                    fs.rm(taskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                        if (rmErr) {
                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + jobDir + '/' + jobId + '-tasks.');
                                        }
                                    });
                                }
                                if (fs.existsSync(resultsDirectory)) {
                                    fs.rm(resultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                        if (rmErr) {
                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + jobDir + '/' + jobId + '-results.');
                                        }
                                    });
                                }
                                // Remove from array of "pending" tasks
                                for (let t=pendingTasks.length-1; t>=0; t--) {
                                    if (pendingTasks[t].jobId == jobId) {
                                        pendingTasks.splice(t, 1);
                                        break;
                                    }
                                }
                                // Add to "error tasks" array
                                errorTasks.push({'jobId': jobId, 'status': 'error', 'code': extractingError.code, 'errorDetectedAt': Date.now(), 'retries': 0, 'info': encodeURIComponent('Internal error [extracting]')});
                                
                                logInfo('Download client files ERROR [extracting]. Task: #' + jobId + '. Code: ' + extractingError.code + '. Details: ' + extractingError.message);
                            }
                        }
                }
            }
        }
    });
}


/*======================================
    Run the client server
========================================*/
http.createServer(app).listen(process.env.PORT, () => {
    let backToPending = [];
    logInfo(`AppyCentric Command Line Server version ${require('root-require')('package.json').version} listening on port ${process.env.PORT}`);
    // As soon as this server is run, we will check if some of the jobs are active (or in-progress, canceled...)
    fs.readdir(path.join(cwd), (readDirErr, clServerContent) => {
        // readDirErr = true;
        if (readDirErr) {
            logInfo(true,'Reading directory ERROR. The error happened while running ALRJ server. Code: ' + readDirErr.code + '. Details: ' + readDirErr.message);
            process.exit(1);
        }
        else {
            // Searching for tasks (ALRJs) directories
            for (let drt=0; drt<clServerContent.length; drt++) {
                // Get directories only (without node modules)
                if (fs.lstatSync(path.join(cwd, clServerContent[drt])).isDirectory() && clServerContent[drt] != 'node_modules' && clServerContent[drt] != 'bin' && clServerContent[drt] != 'logs') {
                    
                    // Check async jobs - if "getJobStatus" exists, jobs may be async
                    if (fs.existsSync(path.join(cwd, clServerContent[drt], 'getJobStatus' + ext))) {
                        let taskDirContent = fs.readdirSync(path.join(cwd, clServerContent[drt])); // Read async jobs' directories

                        if (taskDirContent && taskDirContent.length > 0) {
                            for (let i=0; i<taskDirContent.length; i++) {
                                // Check if "results" directory does exist
                                if (taskDirContent[i].endsWith('-results')) {
                                    let name = taskDirContent[i]; // Get a directory name
                                    let jobId = name.split('-')[0]; // Get a job ID from directory name
                                    
                                    // Async
                                    if (fs.existsSync(path.join(cwd, clServerContent[drt], taskDirContent[i], 'job.async'))) {
                                        let jTimeout = null;
                                        if (fs.existsSync(path.join(cwd, clServerContent[drt], taskDirContent[i], 'job.timeout'))) {
                                            jTimeout = fs.readFileSync(path.join(cwd, clServerContent[drt], taskDirContent[i], 'job.timeout'), 'utf8');
                                        }
                                        let jInfo = '';
                                        if (fs.existsSync(path.join(cwd, clServerContent[drt], taskDirContent[i], '-results/job.info'))) {
                                            fs.readFileSync(path.join(cwd, clServerContent[drt], taskDirContent[i], '-results/job.info'), 'utf8');
                                        }

                                        // If timeout expired (or invalid/or not available)
                                        if (!jTimeout || !Number(jTimeout) || moment() >= moment(Number(jTimeout))) {
                                            logInfo('Invalid TIMEOUT. The error happened while running ALRJ server. Timeout is expired, invalid or not available. Timeout expiration: ' + jTimeout && Number(jTimeout) ?  moment(Number(jTimeout)).toDate().toString() : 'N/A');

                                            // Try to do a cleanup
                                            if (fs.existsSync(path.join(cwd, clServerContent[drt], 'cleanUpJob' + ext))) {
                                                tasksForCleanup.push({'jobDirectory': clServerContent[drt], 'jobId': jobId, 'retries': 0, 'lastAttemptionToCleanup': null});
                                                logDebug("Cleaning up w/ cleanUp script... "); 
                                            }
                                            // Without cleaning up (clean up is not provided)
                                            else {                                                    
                                                let taskDirectory       = path.join(cwd, clServerContent[drt], jobId + '-tasks');
                                                let resultsDirectory    = path.join(cwd, clServerContent[drt], jobId + '-results');
                                                let resultsZipDirectory = path.join(cwd, clServerContent[drt], jobId + '-results.zip');
                                                if (fs.existsSync(taskDirectory)) {
                                                    fs.rm(taskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                                        if (rmErr) {
                                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-tasks.');
                                                        }
                                                    });
                                                }
                                                if (fs.existsSync(resultsDirectory)) {
                                                    fs.rm(resultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                                        if (rmErr) {
                                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-results.');
                                                        }
                                                    });
                                                }
                                                if (fs.existsSync(resultsZipDirectory)) {
                                                    fs.rm(resultsZipDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES) }, (rmErr) => {
                                                        if (rmErr) {
                                                            fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-results.zip.');
                                                        }
                                                    });
                                                }
                                                logDebug("Cleaning up w/o cleanUp script...");
                                            }
                                        }
                                        else {
                                            // Check a status of an ASYNC job
                                            tasksInProcessing.push({'jobDirectory': clServerContent[drt], 'jobId': jobId, 'status': 'in-progress', 'jobType': 'async', 'percentage': null, 'timeout': moment(Number(jTimeout)).toDate(), 'checkedStatusAt': moment().toDate(), 'downloadStatus': 'downloaded', 'payloadUrl': '', 'payloadBody': null, 'tasksDir': jobId + '-tasks', 'resultsDir': jobId + '-results', 'receivedAt': null, 'downloadedAt': Date.now(), 'startedAt': null, 'completedAt': null, 'lastAttemptionToUploadAt': null, 'retries': 0, 'info': jInfo});

                                            checkJobStatus(clServerContent[drt], jobId, null); // Check status
                                        }
                                    }
                                    // May be sync
                                    else {
                                        // Additional checking for "sync" jobs
                                        if (fs.existsSync(path.join(cwd, clServerContent[drt], taskDirContent[i], 'job.sync'))) {
                                            let name  = taskDirContent[i];
                                            let jobId = name.split('-')[0];

                                            backToPending.push({
                                                'jobId': jobId,
                                                'status': 'pending',
                                                'info': 'CL server running',
                                                'percentage': 0
                                            });

                                            let removeTaskDirectory       = path.join(cwd, clServerContent[drt], jobId + '-tasks');
                                            let removeResultsDirectory    = path.join(cwd, clServerContent[drt], jobId + '-results');
                                            let removeResultsZipDirectory = path.join(cwd, clServerContent[drt], jobId + '-results.zip');
                                            if (fs.existsSync(removeTaskDirectory)) {
                                                fs.rm(removeTaskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                                    if (rmErr) {
                                                        fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-tasks.');
                                                    }
                                                });
                                            }
                                            if (fs.existsSync(removeResultsDirectory)) {
                                                fs.rm(removeResultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                                    if (rmErr) {
                                                        fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-results.');
                                                    }
                                                });
                                            }
                                            if (fs.existsSync(removeResultsZipDirectory)) {
                                                fs.rm(removeResultsZipDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                                    if (rmErr) {
                                                        fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-results.zip.');
                                                    }
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Check synchronized jobs
                    else {
                        let syncTasksDirContent = fs.readdirSync(path.join(cwd, clServerContent[drt]));
                        
                        // Update status to "pending" and remove all directories
                        if (syncTasksDirContent && syncTasksDirContent.length > 0) {
                            for (let i=0; i<syncTasksDirContent.length; i++) {
                                if (syncTasksDirContent[i].endsWith('-results')) {
                                    let name  = syncTasksDirContent[i];
                                    let jobId = name.split('-')[0];
                                    
                                    backToPending.push({
                                        'jobId': jobId,
                                        'status': 'pending',
                                        'info': 'CL server running',
                                        'percentage': 0
                                    });

                                    let removeTaskDirectory       = path.join(cwd, clServerContent[drt], jobId + '-tasks');
                                    let removeResultsDirectory    = path.join(cwd, clServerContent[drt], jobId + '-results');
                                    let removeResultsZipDirectory = path.join(cwd, clServerContent[drt], jobId + '-results');
                                    if (fs.existsSync(removeTaskDirectory)) {
                                        fs.rm(removeTaskDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                            if (rmErr) {
                                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-tasks.');
                                            }
                                        });
                                    }
                                    if (fs.existsSync(removeResultsDirectory)) {
                                        fs.rm(removeResultsDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                            if (rmErr) {
                                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-results.');
                                            }
                                        });
                                    }
                                    if (fs.existsSync(removeResultsZipDirectory)) {
                                        fs.rm(removeResultsZipDirectory, {recursive: true, retryDelay: 1000, maxRetries: parseInt(process.env.MAX_FILE_CLEANUP_RETRIES)}, (rmErr) => {
                                            if (rmErr) {
                                                fs.appendFileSync(path.join(cwd, '/invalid-operations-log.txt'), '\rError while removing directory: ' + clServerContent[drt] + '/' + jobId + '-results.zip.');
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }            

            // Firstly, check "back to pending" jobs
            // If "back to pending" array is not empty, statuses of the sync jobs will be updated
            // After that updating, statuses of async jobs (if they are exist) will be solved
            if (backToPending.length > 0) {
                updateStatuses(backToPending, 'pending');
            }
            else {
                CL_SERVER_READY = true;
                longPolling();
            }
        }
    });

});




process.on('SIGINT', () => {
    logInfo('Shutting down the ALRJ server [SIGINT]');
    process.exit(0);
});
process.on('SIGTERM', () => {
    logInfo('Shutting down the ALRJ server [SIGTERM]');
    process.exit(0);
});