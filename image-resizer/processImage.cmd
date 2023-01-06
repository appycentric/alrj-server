REM Resize to user-defined size a single image
REM parameters: <input_image_name> <output_image_name> <size>

convert "%1" -resize "%3" "%2"

EXIT /B %ERRORLEVEL%
