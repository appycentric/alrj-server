#!/bin/bash

#Resize a single image
# parameters: <input_directory> <output_directory> <size>

# check parameters
if [[ "$1" == "" || "$2" == "" || "$3" == "" ]]; then
  echo Not all parameters provided. Make sure you provide three parameters:
  echo 1. Job input directory:  [$1]
  echo 2. Job output directory: [$2]
  echo 3. size:                 [$3]
  echo >./log/processImages.log
  exit 7
fi

# do the job directories exist?
if [[ !((-d "./$1") && (-d "./$2")) ]]; then 
  echo Not all job directories exist. Make sure both these directories exist:
  echo 1. Job input directory:  [$1]
  echo 2. Job output directory: [$2]
  exit 7
fi

# is the job's task directory empty?
if [ "$(ls -A ./$1)" ]; then
   : # ok, directory contains files
else
   echo "Directory ./$1 is Empty. No files to process."
   exit 7
fi

# execute the job on each file in the job's -tasks directory: resizes the
# image and saves the resulting image in the job's -results directory

# make note of any error:
anyretcode=0

cd $1
for file in *
do

  # for each file execute the job, store retcode to variable
  ../processImage.sh "$file" "../$2/$file" "$3"
  retcode=$?

  if [[ $retcode -eq 127 ]]; then # error 127 command not found is 1
     retcode=1 
  fi
  
  if [[ $retcode -eq 0 ]]; then
     echo Processing ./$1/$file to ./$2/$file is a success, returned: $retcode
  else
     anyretcode=$retcode
     echo Processing ./$1/$file to ./$2/$file is an error, returned: $retcode
  fi;
done
cd ..

# are there any errors?
if [[ $anyretcode -eq 0 ]]; then
  : # no errors
else
  echo There were errors executing tasks. Last error: $anyretcode
  exit $anyretcode
fi;

# is the result directory empty?
if [ "$(ls -A ./$2)" ]; then
   : # dir is not Empty"
else
   echo "Directory ./%2 is Empty. There are errors in executing the job"
   exit 7
fi
