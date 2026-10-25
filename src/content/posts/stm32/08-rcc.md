---
title: "第八章 时钟：时钟树与编程配置"
description: "STM32 时钟树结构，以及用 RCC 相关函数把系统时钟配到 72MHz 的编程方法。"
date: 2026-10-25
image: "/images/series/stm32/ch8/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 8
---
## 8.1 [时钟]时钟树

### 时钟和时钟树的概念
![](/images/series/stm32/ch8/01.webp)

### 分频器、锁相环和复用器
![](/images/series/stm32/ch8/02.webp)

### 树根
![](/images/series/stm32/ch8/03.webp)

| | 内 | 外 |
| --- | --- | --- |
| 低 | LSI（Low Speed Internal，40kHz） | LSE（Low Speed External，32.768kHz） |
| 高 | HSI（High Speed Internal，8MHz） | HSE（High Speed External，4~16MHz） |


+ **高速**：
    - HSI：内部 8MHz RC 振荡器
    - HSE：外部 4~16MHz 晶振（常用 8MHz）
+ **低速**：
    - LSI：内部 40kHz RC 振荡器（供 IWDG）
    - LSE：外部 32.768kHz 晶振（供 RTC）

### 树干
![](/images/series/stm32/ch8/04.webp)

### 树枝
![](/images/series/stm32/ch8/05.webp)

## 8.2 [时钟]时钟树编程

### 时钟树的初始状态

![](/images/series/stm32/ch8/06.webp)

### 标准库的启动代码

![](/images/series/stm32/ch8/07.webp)

#### 实验代码

用分号注释\
;                 LDR     R0, =SystemInit

;                 BLX     R0

```c
#include "stm32f10x.h"

int main(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);

    while(1)
    {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
        for(uint32_t i = 0; i<400000; i++); // 延迟500ms
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
        for(uint32_t i = 0; i<400000; i++); // 延迟500ms
    }
}
```

### 时钟树的编程接口

##### RCC 定义

**RCC = Reset And Clock Controller**，是 STM32 中负责**时钟管理、复位控制**的核心模块，所有外设时钟的开启 / 配置都依赖它。

| 函数原型 | 核心作用 |
| --- | --- |
| <code>void RCC_HSEConfig(uint32_t RCC_HSE);</code> | 配置 **高速外部时钟（HSE）** 的开关状态（开启 / 关闭） |
| <code>void RCC_HSICmd(FunctionalState NewState);</code> | 控制 ** 高速内部时钟（HSI）**的使能 / 禁用 |
| <code>void RCC_PLLConfig(uint32_t RCC_PLLSource, uint32_t RCC_PLLMul);</code> | 配置锁相环（PLL）的**时钟源**（HSI/2 或 HSE）和**倍频系数**（×2~×16） |
| <code>void RCC_PLLCmd(FunctionalState NewState);</code> | 控制 PLL（锁相环）的使能 / 禁用 |
| <code>void RCC_SYSCLKConfig(uint32_t RCC_SYSCLKSource);</code> | 选择 **系统时钟（SYSCLK）**的来源（HSI/HSE/PLL） |
| <code>void RCC_HCLKConfig(uint32_t RCC_SYSCLK);</code> | 配置 AHB 总线时钟（HCLK），由 SYSCLK 分频得到（供 CPU 内核） |
| <code>void RCC_PCLK1Config(uint32_t RCC_HCLK);</code> | 配置 APB1 总线时钟（PCLK1），由 HCLK 分频得到（低速外设专用，最高 36MHz） |
| <code>void RCC_PCLK2Config(uint32_t RCC_HCLK);</code> | 配置 APB2 总线时钟（PCLK2），由 HCLK 分频得到（高速外设专用，最高 72MHz） |
| <code>FlagStatus RCC_GetFlagStatus(uint8_t RCC_FLAG);</code> | 读取 RCC 相关标志位（如时钟稳定标志、复位标志等） |
| <code>uint8_t RCC_GetSYSCLKSource(void);</code> | 获取当前 SYSCLK 的实际时钟源（HSI/HSE/PLL） |

### 配置时钟树

### 配置Flash指令预取

![](/images/series/stm32/ch8/08.webp)

#### App_SystemClock_Init

```c
void App_SystemClock_Init(void);

void App_SystemClock_Init(void)
{
    FLASH_PrefetchBufferCmd(ENABLE);
    FLASH_SetLatency(FLASH_Latency_2);
    
    // #1. 开启HSE
    RCC_HSEConfig(RCC_HSE_ON);
    while(RCC_GetFlagStatus(RCC_FLAG_HSERDY) == RESET);
    
    // #2. 配置并启动锁相环
    RCC_PLLConfig(RCC_PLLSource_HSE_Div1, RCC_PLLMul_9);
    RCC_PLLCmd(ENABLE);
    while(RCC_GetFlagStatus(RCC_FLAG_PLLRDY) == RESET);
    
    // #3. 配置AHB APB1 和APB2分频器的分频系数
    RCC_HCLKConfig(RCC_SYSCLK_Div1);
    RCC_PCLK1Config(RCC_HCLK_Div2);
    RCC_PCLK2Config(RCC_HCLK_Div1);
    
    // #4. 切换SYSCLK的来源
    RCC_SYSCLKConfig(RCC_SYSCLKSource_PLLCLK);
    while(RCC_GetSYSCLKSource() != 0x08);
}
```

### 片上外设开关和复位

#### 时钟控制函数

| 函数原型 | 作用 | 对应总线 |
| --- | --- | --- |
| `void RCC_AHBPeriphClockCmd(uint32_t RCC_AHBPeriph, FunctionalState NewState);` | 开启 / 关闭**AHB 总线**外设时钟 | AHB（如 DMA、SRAM、FSMC 等） |
| `void RCC_APB2PeriphClockCmd(uint32_t RCC_APB2Periph, FunctionalState NewState);` | 开启 / 关闭**APB2 总线**外设时钟 | APB2（如 GPIOA~G、USART1、SPI1、ADC1、TIM1 等高速外设） |
| `void RCC_APB1PeriphClockCmd(uint32_t RCC_APB1Periph, FunctionalState NewState);` | 开启 / 关闭**APB1 总线**外设时钟 | APB1（如 USART2/3、SPI2、I2C1/2、CAN、TIM2~4 等低速外设，最高 36MHz） |

#### 外设复位函数

| 函数原型 | 作用 | 对应总线 |
| --- | --- | --- |
| `void RCC_APB2PeriphResetCmd(uint32_t RCC_APB2Periph, FunctionalState NewState);` | 复位**APB2 总线**上的外设 | APB2 |
| `void RCC_APB1PeriphResetCmd(uint32_t RCC_APB1Periph, FunctionalState NewState);` | 复位**APB1 总线**上的外设 | APB1 |

#### 完整实验代码

```c
#include "stm32f10x.h"

void App_SystemClock_Init(void);

int main(void)
{
    App_SystemClock_Init();
    
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);

    while(1)
    {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
        for(uint32_t i = 0; i<400000; i++); // 延迟500ms
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
        for(uint32_t i = 0; i<400000; i++); // 延迟500ms
    }
}

void App_SystemClock_Init(void)
{
    FLASH_PrefetchBufferCmd(ENABLE);
    FLASH_SetLatency(FLASH_Latency_2);
    
    // #1. 开启HSE
    RCC_HSEConfig(RCC_HSE_ON);
    while(RCC_GetFlagStatus(RCC_FLAG_HSERDY) == RESET);
    
    // #2. 配置并启动锁相环
    RCC_PLLConfig(RCC_PLLSource_HSE_Div1, RCC_PLLMul_9);
    RCC_PLLCmd(ENABLE);
    while(RCC_GetFlagStatus(RCC_FLAG_PLLRDY) == RESET);
    
    // #3. 配置AHB APB1 和APB2分频器的分频系数
    RCC_HCLKConfig(RCC_SYSCLK_Div1);
    RCC_PCLK1Config(RCC_HCLK_Div2);
    RCC_PCLK2Config(RCC_HCLK_Div1);
    
    // #4. 切换SYSCLK的来源
    RCC_SYSCLKConfig(RCC_SYSCLKSource_PLLCLK);
    while(RCC_GetSYSCLKSource() != 0x08);
}
```
