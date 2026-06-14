Boxedwine 26R1
April 22, 2026

Project: https://github.com/danoon2/Boxedwine

This is a build for web/javascript using Emscripten.  It also contains a simple web page as an example for launching games.

There are two separated builds, multi-threaded and single threaded.

If you are trying to get a specific app or game to work, you might want to try both.  

In general the multi-threaded version is faster, but it requires that you set these http headers which may not be possible on some servers, like github.

Header add Cross-Origin-Opener-Policy "same-origin"
Header add Cross-Origin-Embedder-Policy "require-corp"

In each build, it contains a super stripped down version of the Wine 6.0 file system, boxedwine.zip.  But I also included in the Wine11 folder a boxedwine.zip based on Wine 11.

Wine 11 faster, but some apps/games may have some issues.

This stripped down file systems should handle a lot of 32-bit/16-bit apps and games and includes DirectDraw support.  

OpenGL and Direct3D are not supported in the Web/Emscripten build because they can not currently be converted to WebGL.

To see some examples of these builds running see

https://www.boxedwine.org/v/26R1/

Known Issues:

I have seen a few index out of bounds exceptions in audio