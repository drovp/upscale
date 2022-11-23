# @drovp/upscale

[Drovp](https://drovp.app) plugin for upscaling images and videos with [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) or [waifu2x](https://github.com/nagadomi/waifu2x) ([nihui/waifu2x-ncnn-vulkan](https://github.com/nihui/waifu2x-ncnn-vulkan)) neural networks.

Why both? I personally find ESRGAN to be better for art, and waifu2x for photos.

NOTE: If you're getting GPU related or any errors at all, try setting the **GPU ID** option to `-1`, which switches waifu2x into a slower, but more reliable CPU mode.

NOTE 2: Upscaling **videos** takes considerable amount of time and space, since all frames have to be extracted into lossless png files, upscaled one by one, and only then re-encoded into a new video (details in [#1](https://github.com/drovp/upscale/issues/1#issuecomment-1120235110)).
