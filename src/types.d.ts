type ModelName =
	| 'models-cunet'
	| 'models-upconv_7_anime_style_art_rgb'
	| 'models-upconv_7_photo'
	| 'realesr-animevideov3'
	| 'realesrgan-x4plus'
	| 'realesrgan-x4plus-anime';

interface Dependencies {
	waifu2x: string;
	realesrgan: string;
	ffmpeg: string;
	ffprobe: string;
}
