# 自定义图标（可选）

这个目录用于放**自己画的** SVG 图标，`astro-icon` 会自动扫描这里。

用法：把 `my-logo.svg` 放进来，然后在任何组件里写

```astro
---
import { Icon } from 'astro-icon/components';
---
<Icon name="my-logo" class="h-5 w-5" />
```

（注意：不加集合前缀就是本地图标；`ri:github-line`、`material-symbols:home` 这种带冒号的来自 npm 里的 iconify 图标集，不用放这里。）

平时不用管这个目录，留空不影响任何功能。
