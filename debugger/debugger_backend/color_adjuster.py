import colorsys

def adjust_brightness(color, brightness_factor):
    hls = colorsys.rgb_to_hls(*[x/255.0 for x in color])
    hls = (hls[0], max(0, min(1, hls[1] + brightness_factor)), hls[2])
    rgb = [int(x*255.0) for x in colorsys.hls_to_rgb(*hls)]
    return rgb


def rgb_to_ansi(rgb):
    return '\033[38;2;{};{};{}m'.format(*rgb)

def bold_and_italicize_text(text):
    return f"\033[1m\033[3m{text}\033[0m"

def hex_to_rgb(hex_code):
    hex_code = hex_code.lstrip('#')
    return tuple(int(hex_code[i:i+2], 16) for i in (0, 2, 4))