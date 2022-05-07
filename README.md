# @drovp/upscale

[Drovp](https://drovp.app) plugin for upscaling images and videos with [waifu2x](https://github.com/nagadomi/waifu2x) neural network.

Uses [nihui/waifu2x-ncnn-vulkan](https://github.com/nihui/waifu2x-ncnn-vulkan) and ffmpeg binaries under the hood.

NOTE: If you're getting GPU related or any errors at all, try setting the **GPU ID** option to `-1`, which switches waifu2x into a slower, but more reliable CPU mode.

NOTE 2: Upscaling videos takes considerable amount of time and space, since all frames have to be extracted into lossless png files, upscaled one by one, and only then re-encoded into a new video (details in [#1](https://github.com/drovp/upscale/issues/1#issuecomment-1120235110)).

## Changelog

### 2.0.0

- Added support for upscaling video.
- Added support for more input image types. Before you could drop only `jpg`, `webp`, and `png` files, now you can also drop anything that ffmpeg understands, which is pretty much almost everything.
- Added quality control for `jpg` and `webm` output formats.

### 1.0.0

-   Initial release.
