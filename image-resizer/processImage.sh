#!/bin/bash

#Resize to user defined size a single image
# parameters: <input_image_name> <output_image_name> <size>

convert $1 -resize $3 $2

exit $?