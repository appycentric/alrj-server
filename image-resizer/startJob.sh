#!/bin/bash

# This demo shows how users can upload files and enter parameters, 
# which are then processed by your server in some way, and then
# results are returned to respective users.


# To demonstrate how this works, this demo adds text to images.

# A user can upload one or multiple images and have them resized. The demo
# modifies all the images by producing their copies of the requested size.


# For each task, this script (which must be called startJob.sh) is called
# by the AppyCentric system. Parameters provided are: 
# 1. jobId
# 2. json containing any user defined parameters. 

# Instructions: 
#
# jobid is the Job ID. Any input files are already placed by the system in your
# ./<jobid>-tasks directory. When the system executes the startJob.sh, the
# script is expected to place result files in your ./<jobid>-results directory.
#
# Contents of the json object provided in the parameter2 are completely up to
# you to define - this is how you communicate data entered by your users to 
# your job processor.

# In this simple demo, we will expect to receive a json containing a single 
# variable "size". The variable is assumed to be formatted as 
# <widthPixels>x<heightPixels>
# For example: { size: "1920x1080" }

# This script will extract the size and pass it as a parameter to
# our demo script. The demo script simply resizes the images
# provided in the job to the given size.

# Parameter $1 is the jobid. Based on this parameter we already have the 
# Tasks directory: $1-tasks and the Results directory: $1-results
# Now we need to extract "size" from the json parameter $2 and call
# ./processAllImages.sh input-directory output-directory size



# check parameters
if [[ "$1" == "" || "$2" == "" ]]; then
  echo Not all parameters provided. Make sure you provide two parameters:
  echo 1. Job id:  [$1]
  echo 2. Json parameters: [$2]
  exit 7
fi

# do the job directories exist?
if [[ !((-d "./$1-tasks") && (-d "./$1-results")) ]]; 
then 
  echo Not all job directories exist. It is expected that both these directories exist:
  echo 1. Job input directory:  [$1-tasks]
  echo 2. Job output directory: [$1-results]
  exit 7
fi

# is the job's task directory empty?
if [ "$(ls -A ./$1-tasks)" ]; then
   : # ok, directory contains files
else
   echo "Directory ./$1 is Empty. No files to process."
   exit 7
fi



# as a second parameter, this script accepts JSON objects embedded in single quotes
# or not embedded in quotes at all. Double quoted names and values are mandatory.
# Examples:
# - valid input and recommended:  '{"name": "Jack and the Beanstalk", "author": "unknown"}'
# - valid input:                   {"name": "Jack and the Beanstalk", "author": "unknown"}
# - invalid input:                '{ name: "Jack and the Beanstalk",   author:  "unknown"}'
# - invalid input:                 { name: "Jack and the Beanstalk",   author:  "unknown"}

#Remove enclosing single quotes from the JSON parameter, if there are any:
noquotes="$(awk '{if(substr($0,1,1)=="'\''") print substr($0,2,length($0)-2); else print($0); }' <<< $2)"
# save json parameters to file
echo "$noquotes" > ./$1-tasks/parameters.json


# parse the "size" parameter from file to a file size.txt
jq -r '.size' ./$1-tasks/parameters.json > ./$1-tasks/size.txt

# read file into variable "size":
read -d $'\x04' size < "./$1-tasks/size.txt"

#delete temporary files from input directory:
rm ./$1-tasks/parameters.json
rm ./$1-tasks/size.txt


echo "--- Starting job by executing command: ./processAllImages.sh with parameters:"
echo "---      Input directory:  $1-tasks"
echo "---      Output directory: $1-results"
echo "---      Size:             \"$size\""

echo ./processAllImages.sh "$1-tasks" "$1-results" "$size"
./processAllImages.sh "$1-tasks" "$1-results" "$size"
exit $?
