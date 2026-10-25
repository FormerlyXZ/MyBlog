---
title: "第一章 准备：环境搭建与芯片认识"
description: "Keil MDK 环境搭建、STM32F103 的基本信息与引脚分布，第一个程序跑通。"
date: 2026-10-25
image: "/images/series/stm32/ch1/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 1
---
## 1.1 [准备]安装开发环境

## 梳理实验思路

### 搭建电路

![](/images/series/stm32/ch1/01.webp)

### [keil]编写程序

![](/images/series/stm32/ch1/02.webp)

#### 实验代码

```c
#include "stm32f10x.h"
#include "delay.h"

int main(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0 | GPIO_Pin_1 | GPIO_Pin_2 | GPIO_Pin_3 | GPIO_Pin_4;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;

    GPIO_Init(GPIOA, &GPIO_InitStruct);

    while(1)
    {
        for(uint32_t i=0;i<5;i++)
        {
            GPIO_WriteBit(GPIOA, GPIO_Pin_0 << ((i-1 + 5) % 5), Bit_RESET);
            GPIO_WriteBit(GPIOA, GPIO_Pin_0 << i, Bit_SET);
            Delay(100);
        }
    }
}
```

### 运用下载器

![](/images/series/stm32/ch1/03.webp)

连接好下载器后，在keil界面点击download下载按钮，将程序（需要提前编译好）下载到单片机上。

#### 下载失败原因归纳

1. 接线错误
2. Windows 无法自动找到 STM32 ST-LINK 的驱动程序，需要**手动安装官方驱动**来解决

#### 一、下载官方驱动

1. 访问 ST 官网驱动下载页：[STSW-LINK009](https://www.st.com/en/development-tools/stsw-link009.html)
2. 点击 “Get Software”，下载对应 Windows 版本的驱动压缩包（无需注册，直接下载）。
3. 将下载的压缩包解压到一个容易找到的文件夹（例如 <code>D:\ST-LINK_Driver</code>）。

***

#### 二、手动安装驱动

1. 打开**设备管理器**（右键 “此电脑”→“管理”→“设备管理器”），找到带黄色感叹号的 <code>STM32 STLink</code> 设备。
2. 右键该设备 → 选择 **“更新驱动程序”**。
3. 在弹出的窗口中，选择 **“浏览我的计算机以查找驱动程序软件”**。
4. 点击 “浏览”，定位到刚才解压的驱动文件夹（路径示例：<code>D:\ST-LINK_Driver\stsw-link009\All\Drivers\ST-LINK_USB</code>），然后点击 “下一步”。
5. 系统会自动安装驱动，安装完成后，设备管理器中的设备名称会变为 <code>ST-Link Debug</code> 或 <code>ST-LINK/V2</code>，且黄色感叹号消失。

### 运行

按一下单片机上的复位按钮，单片机开始运行。

***

## 安装keil5

![](/images/series/stm32/ch1/04.webp)

### 百度网盘文件地址

<https://pan.baidu.com/s/1kcKd063anDtFZ1gG97cOKg?pwd=3kvt> 提取码: 3kvt

## 1.2 [准备]STM32基本信息

## 含义
ST：意法半导体

M：单片机

32：32位

STM32：ST公司生产的32位单片机的统称

## 作用/角色
起控制器的功能

![](/images/series/stm32/ch1/05.webp)

## 芯片型号
芯片上包含STM32的型号

STM32 F103 C8T6

ST品牌，M32产品类型，F103系列，C8T6规格型号

C 8 T 6

C 引脚数量，48引脚

8 Flash容量（相当于硬盘/存储器） 8=64Kbytes，64K容量

T 封装类型（焊盘形状） T=LQFP

6 温度范围 6=-40~85℃

## 1.3 [准备]STM32引脚分布

### 在手册中寻找引脚分布图
《DS5319 stm32f10x中等密度mcu数据手册（英文）》

LQFP48引脚分布图

![](/images/series/stm32/ch1/06.webp)

### 引脚编号规则


![](/images/series/stm32/ch1/07.webp)

---

### 特殊引脚的功能和作用
![](/images/series/stm32/ch1/08.webp)

#### VDD
VDD - 供电（接3.3V）

#### VSS
VSS - 地（接地，0V）

#### NRST
NRST - 复位（接复位按钮），用于重新启动单片机上的程序

#### VBAT
VBAT - 备用电池，主电源断电后，若接了备用电池，则备用电池工作，以保证单片机的一部分功能能够正常运行

#### BOOT0
BOOT0 - 启动模式选择，通过左右移动跳帽，选择芯片启动模式（低/高电平）

#### 其余引脚
其余引脚皆为普通引脚

### 普通引脚的命名规则
以字母作为组编号

以数组作为引脚编号

GPIOA：PA0， PA1, PA2, ..., PA15

GPIOB：PB0， PB1, PB2, ..., PB15

GPIOC：PC13, PC14, PC15

GPIOD：PD0, PD1
