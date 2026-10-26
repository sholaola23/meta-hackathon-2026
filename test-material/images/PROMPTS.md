# Muse Image prompts for the stall test fixtures

Generated 26 October 2026 with Meta Model API `POST https://api.meta.ai/v1/images/generations`, model `muse-image-1.0` (docs: https://dev.meta.ai/docs/image-generation).
Request parameters for every call: `n: 1`, `size: "1536x1024"` (sets the aspect ratio only), `output_format: "png"`, default `response_format` (b64_json). Built-in web/image search left on (default).
The model returned 1920x1280 PNGs. Each file was downscaled in place to 1500x1000 with `sips -Z 1500`.

Synthetic test fixtures only. Ground truth item lists are in `../stalls.json`. The generated images may differ from them: see the notes per file.

## stall-1-provisions-v1.jpg

```text
Realistic documentary-style smartphone photo, not studio, not illustration. A small provisions kiosk in Lagos, Nigeria, in natural daylight, shot straight on from a customer's eye level. Weathered wooden shelves with items standing apart in neat rows, with gaps between them so each item can be counted. Exactly these products are on the shelves, each one clearly visible and not overlapping: one single pack of Indomie instant noodles, one big tin of Peak evaporated milk, one tin of Milo chocolate drink, one pack of Golden Morn cereal, one jar of Bournvita, and one Gala sausage roll in its wrapper. No other products. No people, no faces. Slight phone-camera grain, real market atmosphere.
```

## stall-1-provisions-v2.jpg

```text
Candid phone photo taken at a slight angle of a Lagos roadside provisions kiosk in bright afternoon daylight. Two plain wooden shelves, products spaced apart in a row: a single Indomie noodles pack, a large Peak milk tin, a Milo tin, a Golden Morn cereal pack, a Bournvita jar, and a Gala sausage roll. Each of these six items appears once and is fully visible. Painted wooden kiosk frame, dusty street visible at the edge. Photorealistic, documentary, no people or faces.
```

## stall-2-fabrics-v1.jpg

```text
Realistic documentary-style smartphone photo of a fabric stall in Balogun Market, Lagos, Nigeria, daylight under a canopy. Bright patterned textiles, each piece clearly separate so they can be counted: one folded Ankara wax print in blue and yellow, one folded Ankara wax print with a red pattern, one folded gold lace fabric, one purple aso oke set, and one folded plain white cotton fabric. Some pieces hang from a rail, others are stacked on a wooden table, but all five are distinct and visible. No people, no faces. Real market atmosphere, phone-camera look, not a studio shot.
```

## stall-2-fabrics-v2.jpg

```text
Candid phone photo looking down at a wooden table at a Balogun market fabric stall in Lagos, natural light. Five folded fabrics laid side by side in a row, not overlapping: a blue-and-yellow Ankara wax print, a red-patterned Ankara wax print, shimmering gold lace, a purple woven aso oke set, and a plain white cotton fabric. Busy market background slightly blurred. Photorealistic, documentary, no people or faces.
```

## stall-3-phone-accessories-v1.jpg

```text
Realistic documentary-style smartphone photo of a phone accessories table at Computer Village, Ikeja, Lagos, Nigeria. A glass-topped display table in daylight, items in small packets and boxes laid out separately with space between them: one USB-C charging cable in a packet, one white iPhone-style charger head, one 20000mAh power bank, one pair of wired earphones in a packet, one phone case, one screen protector in a thin packet, and one small Bluetooth speaker. Exactly seven items, each clearly visible and countable. Generic packaging, no readable brand logos. No people, no faces. Some reflection on the glass, phone-camera look.
```

## stall-3-phone-accessories-v2.jpg

```text
Candid overhead phone photo of a glass-top accessories table in Computer Village, Ikeja, Lagos. Laid out on the glass: a coiled USB-C cable, a white phone charger head, a black power bank, wired earphones, a phone case, a screen protector packet, and a small round Bluetooth speaker. Each item appears once, separated, generic unbranded packaging. Glare from the glass, cluttered market edges. Photorealistic documentary, no people or faces.
```

## stall-4-foodstuff-v1.jpg

```text
Realistic documentary-style smartphone photo of a foodstuff stall at Mile 12 market, Lagos, Nigeria, daylight. Open basins and sacks with heaped produce, crowded and slightly messy. On the stall: an open basin heaped with white rice with a paint bucket used as a measure, an open basin heaped with brown beans with a paint bucket measure, an open basin of white garri with a paint bucket measure, a one-litre bottle of red palm oil, a one-litre bottle of groundnut oil, a small cup filled with dried crayfish, a tomato paste sachet, and one medium yam tuber. Items close together and some partly overlapping, but each one is present. No people, no faces. Phone-camera look, not a studio shot.
```

## stall-4-foodstuff-v2.jpg

```text
Candid phone photo at a busy Mile 12 foodstuff stall in Lagos from a low angle. Heaped basins of rice, brown beans and white garri, each with a plastic paint bucket measure sitting on top of the heap. In front: a 1 litre bottle of palm oil and a 1 litre bottle of groundnut oil, a small cup of crayfish, a single tomato paste sachet, and one medium yam tuber partly behind a basin. Sacks and other produce crowd the background. Photorealistic documentary, uneven light, no people or faces.
```

## stall-5-mixed-cluttered-v1.jpg

```text
Realistic documentary-style smartphone photo of a cluttered roadside kiosk in Lagos, Nigeria, in warm evening light with one bulb. Items stacked and partly hidden behind each other, strips of sachets hanging from the top. The kiosk holds: a 75cl bottle of water, a 50cl bottle of Coca-Cola, a hanging strip of Milo sachets, a hanging strip of detergent sachets, a big loaf of bread in a plastic bag, a crate of eggs, a pack of sugar cubes, a pack of Cabin biscuits, and a bar of soap. Crowded and partly occluded, but each item is present and at least partly visible. No people, no faces. Phone-camera look, slight motion blur and grain.
```

## stall-5-mixed-cluttered-v2.jpg

```text
Candid evening phone photo of a crowded Lagos roadside kiosk window, lit by a single hanging bulb. One strip of Milo sachets and one strip of detergent sachets hang from the top, partly covering the shelves. On the counter, stacked and overlapping: a paper tray crate of eggs, a big loaf of bread in a plastic bag, a 75cl bottle of water, a 50cl bottle of Coca-Cola, a pack of Cabin biscuits, a box of sugar cubes, and one wrapped bar of soap lying in front of the bread with its corner partly hidden by the egg crate. Every one of these nine items must appear, the bar of soap must be visible. Photorealistic documentary, cluttered, no people or faces.
```

The first attempt with the prompt below had no bar soap, so it was regenerated once with the prompt above. The rejected first image is not kept in the repo.

```text
Candid evening phone photo of a crowded Lagos roadside kiosk window, lit by a single hanging bulb. Strips of Milo sachets and detergent sachets hang across the top, partly covering the shelves. On the counter and shelves, stacked and overlapping: a crate of eggs, a big loaf of sliced bread, a bottle of water, a bottle of Coca-Cola, a pack of Cabin biscuits, a box of sugar cubes, and a bar of soap partly hidden behind the bread. Photorealistic documentary, cluttered, no people or faces.
```
