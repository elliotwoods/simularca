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

# Rendering

* Speed up file handling
    * Async download (e.g. max buffer size)
    * Just faster
* Anti-aliasing
* Preview before render (just show in realtime)

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

# Housekeeping

* Check for where multiple patterns exist to perform the same function e.g.
    * components
    * sub-menus
    * blocks in the inspector
    * 
