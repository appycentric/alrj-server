REM Add watermark to a single image
REM parameters: <input_directory> <output_directory> <size>

REM check parameters
if ["%~2"] == [""] (
  echo Not all parameters provided. Make sure you provide two parameters:
  echo 1. Job id:  [%1]
  echo 2. Json parameters: [%2]
  exit /b 7
)

REM do the job directories exist?
if not exist ".\%~1\" goto nodirs
if not exist ".\%~2\" goto nodirs
goto next1
:nodirs
  echo Not all job directories exist. It is expected that both these directories exist:
  echo 1. Job input directory:  [%~1]
  echo 2. Job output directory: [%~2]
  exit /b 7
:next1

REM is the job's task directory empty?
dir /A/B/S ".\%~1\" | findstr /L ".">NUL && GOTO next2
   echo "Directory .\%~1\ is Empty. No files to process."
   exit /b 7
:next2

REM execute the job on each file in the job's -tasks directory: add watermark and save resulting image in the job's -results directory

REM make note of any error:
set anyretcode=0
cd %~1
setlocal enabledelayedexpansion
for %%f in (*.*) do (

  REM for each file execute the job, store retcode to variable
  REM echo calling ..\processImage.cmd "%%f" "..\%~2\%%f" %3
  echo calling:  ..\processImage.cmd "%%f" "..\%~2\%%f" %3
  call ..\processImage.cmd "%%f" "..\%~2\%%f" %3

  if not exist "..\%~2\%%f" set anyretcode=%retcode%
  if not exist "..\%~2\%%f" echo Processing .\%1\%%f to .\%2\%%f is an error, returned: %retcode%
  if not exist "..\%~2\%%f" cd ..
  if not exist "..\%~2\%%f" endlocal
  if not exist "..\%~2\%%f" exit /b 1
)

cd ..


REM is the result directory empty?
dir /A/B/S ".\%~2\" | findstr /L ".">NUL && GOTO next4
   echo "Directory .\%2 is Empty. There are errors in executing the job"
   exit /b 8
:next4

exit /b 0