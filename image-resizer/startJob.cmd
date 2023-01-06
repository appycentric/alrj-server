@echo off
REM This is the simple synchronous job execution script. 
REM Instructions: 

REM 1. execute your task.
REM    Input parameters:
REM       Parameter %1 represents job id. 
REM       Parameter %2 represents user parameters in JSON format
REM       Any job input files will be found in the .\<jobid>-tasks directory.
REM    Output parameters:
REM       The task should place output result files in the .\<jobid>-results directory.
REM       If the task is a success, exit with code 0.
REM       If the task is an error, exit with code 8.
REM       For more detailed error codes, please see the documentation.

REM This demo shows how users can upload files and enter parameters, 
REM which are then processed by your server in some way, and then
REM results are returned to respective users.


REM To demonstrate how this works, this demo resizes resizes images.

REM A user can upload one or multiple images. The demo modifies all the 
REM images by resizing them.

REM For each task, this script (which must be called startJob.cmd) is called
REM by the AppyCentric system. Parameters provided are: 
REM 1. jobId
REM 2. json containing any user defined parameters. 

REM Instructions: 

REM jobid is the Job ID. Any input files are already placed by the system in your
REM ./<jobid>-tasks directory. When the system executes the startJob.sh, the
REM script is expected to place result files in your ./<jobid>-results directory.

REM Contents of the json object provided in the parameter2 are completely up to
REM you to define - this is how you communicate data entered by your users to 
REM your job processor.

REM In this simple demo, we will expect to receive a json containing a single 
REM variable "size". For example: 
REM { "size": "640x480" }

REM Parameter $1 is the jobid. Based on this parameter we already have the 
REM Tasks directory: $1-tasks and the Results directory: $1-results
REM Now we need to extract watermark text from the json parameter $2 and call
REM ./processAllImages.cmd input-directory output-directory  <size>



REM check parameters
if [%2] == [] (
  echo Not all parameters provided. Make sure you provide two parameters:
  echo 1. Job id:  [%1]
  echo 2. Json parameters: [%2]
  exit /b 7
)

REM do the job directories exist?
if not exist ".\%~1-tasks\" goto nodirs
if not exist ".\%~1-results\" goto nodirs
goto next1
:nodirs
  echo Not all job directories exist. It is expected that both these directories exist:
  echo 1. Job input directory:  [%~1-tasks]
  echo 2. Job output directory: [%~1-results]
  exit /b 7
:next1

REM is the job's task directory empty?
dir /A/B/S ".\%~1-tasks\" | findstr /L ".">NUL && GOTO next2
   echo "Directory .\%~1-tasks\ is Empty. No files to process."
   exit /b 7
:next2


REM save json parameters to file
REM replace ' with " inside JSON:
set _param2=%~2
set _param2=%_param2:'=\"%
set _param2=%_param2:\=%
echo %_param2% > .\%~1-tasks\parameters.json

REM parse the size parameter from file to a file size.txt
jq -r .size .\%~1-tasks\parameters.json > .\%~1-tasks\size.txt

if "%ERRORLEVEL%"=="0" goto next3
  echo Could not parse your second parameter for watermark. Expected format not found: {... "size": "640x480" ... }
  echo Your input: %2
  echo JQ je rekao %ERRORLEVEL%
  exit /b 1
:next3

REM read file into variable watermark:
for /f "delims=" %%x in (.\%~1-tasks\size.txt) do set size=%%x
if "%ERRORLEVEL%"=="0" goto next4
  echo Could not read "size" variable from file ".\%~1-tasks\size.txt"
  exit /b 1
:next4

REM delete temporary files from input directory:
del .\%~1-tasks\parameters.json
del .\%~1-tasks\size.txt


echo --- Starting job by executing command: .\processAllImages.com with parameters:"
echo ---      Input directory:  "%~1-tasks"
echo ---      Output directory: "%~1-results"
echo ---      Size:   "%size%"

echo .\processAllImages.cmd "%~1-tasks" "%~1-results" "%size%"
.\processAllImages.cmd "%~1-tasks" "%~1-results" "%size%"
exit /b %ERRORLEVEL%
