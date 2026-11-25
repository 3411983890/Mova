// 读当前显示器与窗口尺寸（判断 2300×1450 是否放得下）。
return {
  screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight },
  dpr: devicePixelRatio,
  inner: { w: innerWidth, h: innerHeight },
  outer: { w: outerWidth, h: outerHeight },
};
