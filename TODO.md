# Interface


## Can be improved

e.g. made richer, more interactive, more interated

* Snapshot selection
* Material reference selection
* Actor refrence selection

# Environments

Auto-select environment based on proximity / other (be able to select/exclude environments per actor, or use scene graph heirarchy?)

* Light probes
    * With exclude actor reference selection list
* Daylight environment
* HDRI environment

Scene can choose which environment is the 'backgruond plate'

Let's also look into ambient occlusion, shadows, global illumination, etc

# Rendering

* Speed up file handling
    * Async download (e.g. max buffer size)
    * Just faster
* Anti-aliasing
* Preview before render (just show in realtime)
* There seems there might be a big that after rendering ends that we get stuck at the end of the camera path sometimes?

# Deploying

Test deploying scenes to Vercel.

* Remove the top row (e.g. no session selection - the session is locked, no max/min/etc)
* Have some minimal branding 'SIMULARCA' e.g. that could go into the next bar
* Consider playback/etc

# Presentation mode

* A series of 'slides' where documents (e.g. Notion/markdown/other) are attached to scene positions and/or actors
* Forwards/backwards between slides
* Customise camera angles / document rendering position per slide
* Handle slightly various 

# Ray-tracing

e.g. Cycles/Octane/that open source optically accurate one

This would be amazing if possible

# Logo

Make a decent logo (e.g. by hand)

# Camera

Options of different interactive cameras:

* ofxGrabCam style
* Current orbit camera style
* Unreal first person style

Perhaps we can combine things, e.g.:
* left click drag = orbit around whatever is under the mouse cursor (ofxGrabCam style)
* right click drag = look around
* middle click or both button drag = pan

whilst in right click drag, WASD keys are active (they are not active otherwise)

Also fix the current camera bookmark / up/down/left/etc system (e.g. better hotkeys)

X,Y,Z widget in the corner of the screen

# Housekeeping

* Check for where multiple patterns exist to perform the same function e.g.
    * components
    * sub-menus
    * blocks in the inspector
    * 
# Remderer

* Speed up
* Sometimes we don't even need the video, we just want to cache the frames
* If 'Render Debug Views' is disabled, then we shouldn't render curves
* Smarten up this dialog box

# Timings

* If an actor takes > 1/framerate for draw or update, then show that time in the scene graph

# Time

Better transport controls
Consider showing time at the bottom of the viewport (e.g. with keyframes, and skipping affects total time)
Option of 'timeline mode' and 'continous mode'

# Filesystem

Use local filesystem default location in AppData, etc for:

* Window layout
* Recent projects

Projects should live in their own folders. Also allow for filetype association

# Camera Path

* Show seconds ticks along the camera path
* Better controls in the inspector for controlling keyframes (consider keyframe view at bottom of viewport)

# Inspector controls

* Rangeless slider should auto-show digits correctly when space is reduced (i.e. show the most significant figures)

# Saving and loading

* When quitting / exiting a file without saving, notify the user and suggest that they save
* Check filesystem for changing the notion of projects to something else
* Be able to type in the project dialogue and have it search through recent projects and/or snapshots

# Refactoring

* Try to identify any software patterns which are only used once and could be rolled into other existing patterns
* Try to create (and keep up to date) a markdown file with a list of design patterns for teh software

# Status

* We recently implemented grouping in status panels. Review each actor's status system and apply grouping appropriately