#!/bin/bash
# loop the rendered ambience mp3 on the mac's default output, forever, restarting if anything kills it.
# volume = the laptop's volume keys. ctrl-c to stop.
while true; do afplay ~/Desktop/clocktower-ambience.mp3; sleep 0.5; done
