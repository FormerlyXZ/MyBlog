---
title: "第十章 ADC：逐次逼近、采样时间与多通道转换"
description: "逐次逼近型 ADC 原理、ADC 结构框图、采样与转换时间、常规单通道转换、定时器触发与扫描模式。"
date: 2026-10-25
image: "/images/series/stm32/ch2/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 10
---
## 10.1 [ADC]逐次逼近型ADC

### ADC是什么
Analog（模拟信号）、Digital（数字信号）、Converter（转换器）  

### 单片机里的ADC模块
![](/images/series/stm32/ch2/01.webp)

### 采样深度的概念
采样深度：用多少位二进制数表示转换结果

![](/images/series/stm32/ch10/02.webp)

### 逐次逼近型ADC简介
![](/images/series/stm32/ch10/03.webp)

![](/images/series/stm32/ch10/04.webp)

### 采样保持电路
![](/images/series/stm32/ch10/05.webp)

![](/images/series/stm32/ch10/06.webp)

闭合开关：采样阶段

断开开关：保持阶段

### 案例

## 10.2 [ADC]ADC模块的结构框图

![](/images/series/stm32/ch10/07.webp)

### ADC的多路复用
![](/images/series/stm32/ch10/08.webp)

![](/images/series/stm32/ch10/09.webp)

### 常规序列
![](/images/series/stm32/ch10/10.webp)

### 注入序列
![](/images/series/stm32/ch10/11.webp)

### 案例
![](/images/series/stm32/ch10/12.webp)

## 10.3 [ADC]采样时间和转换时间

### ADC的时钟频率
若不改变初始设置，PCLK2 = 72MHz / 6 = 12MHz

### 转换时间的计算方法
![](/images/series/stm32/ch10/13.webp)

### 采样时间和信号源内阻的关系
![](/images/series/stm32/ch10/14.webp)

### 信号源内阻的计算方法
![](/images/series/stm32/ch10/15.webp)

![](/images/series/stm32/ch10/16.webp)

### 采样时间的计算方法
![](/images/series/stm32/ch10/17.webp)

![](/images/series/stm32/ch10/18.webp)

![](/images/series/stm32/ch10/19.webp)

## 10.4 [ADC]常规单通道转换

![](/images/series/stm32/ch10/20.webp)

![](/images/series/stm32/ch10/21.webp)

### 初始化IO引脚
![](/images/series/stm32/ch10/22.webp)

### 配置ADC的时钟
### ADC的编程接口
| **序号** | **分类** | **编程接口** | **作用** |
| --- | --- | --- | --- |
| **1** | <br/><br/><br/>通用 | ADC_Init | 设置 ADC 的基本参数 |
| **2** | | ADC_Cmd | 总开关 |
| **3** | | ADC_GetFlagStatus | 获取标志位的值 |
| **4** | | ADC_ClearFlag | 清除标志位 |
| **5** | | ADC_ITConfig | 配置中断 |
| **6** | | ADC_DMACmd | 配置 DMA 请求 |
| **7** | | ADC_TempSensorVrefintCmd | 温度计和参考电压开关 |
| **8** | <br/><br/>常规序列 | ADC_RegularChannelConfig | 配置常规序列的通道 |
| **9** | | ADC_ExternalTrigConvCmd | 外部触发开关（常规） |
| **10** | | ADC_SoftwareStartConvCmd | 软件启动（常规） |
| **11** | | ADC_GetConversionValue | 读取 DR 寄存器的值 |
| **12** | <br/><br/><br/>注入序列 | ADC_InjectedSequencerLengthConfig | 设置注入序列的长度 |
| **13** | | ADC_InjectedChannelConfig | 配置注入序列的通道 |
| **14** | | ADC_ExternalTrigInjectedConvCmd | 外部触发开关（注入） |
| **15** | | ADC_ExternalTrigInjectedConvConfig | 选择注入序列的外部触发 |
| **16** | | ADC_SetInjectedOffset | 设置注入序列的通道偏置 |
| **17** | | ADC_SoftwareStartInjectedConvCmd | 软件启动（注入） |
| **18** | | ADC_GetInjectedConversionValue | 读取 JDRx 寄存器的值 |
| **19** | <br/>校准相关 | ADC_ResetCalibration | 复位校准寄存器 |
| **20** | | ADC_GetResetCalibrationStatus | 查询复位是否完成 |
| **21** | | ADC_StartCalibration | 启动校准 |
| **22** | | ADC_GetCalibrationStatus | 查询校准是否完成 |


### 初始化ADC的基本参数
一般使用右对齐

![](/images/series/stm32/ch10/23.webp)

### 配置常规序列
![](/images/series/stm32/ch10/24.webp)

### 闭合ADC的总开关
### 启动并读取转换结果
![](/images/series/stm32/ch10/25.webp)

#### 完整实验代码
```c
#include "stm32f10x.h"

void App_ADC1_Init(void);
void App_OnBoardLED_Init(void);

int main(void)
{
    App_ADC1_Init();
    App_OnBoardLED_Init();
    
    while(1)
    {
        // #1. 清除EOC标志位
        ADC_ClearFlag(ADC1, ADC_FLAG_EOC);
        
        // #2. 通过软件启动的方式发送脉冲
        ADC_SoftwareStartConvCmd(ADC1, ENABLE);
        
        // #3. 等待常规序列转换完成
        while(ADC_GetFlagStatus(ADC1, ADC_FLAG_EOC) == RESET);
        
        // #4. 读取转换的结果
        uint16_t dr = ADC_GetConversionValue(ADC1);

        // #5. 把结果转换成电压
        float voltage = dr * (3.3f / 4095);
        
        if(voltage > 1.5)
        {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
        }
        else
        {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
        }
    }
}

void App_ADC1_Init(void)
{
    // #1. 初始化PA0引脚，模拟模式
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AIN;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 配置ADC模块的时钟
    RCC_ADCCLKConfig(RCC_PCLK2_Div6); // 六分频
    
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_ADC1, ENABLE);
    
    // #3. 初始化ADC的基本参数
    ADC_InitTypeDef ADC_InitStruct = {0};
    
    ADC_InitStruct.ADC_ContinuousConvMode = DISABLE; // 关闭连续模式
    ADC_InitStruct.ADC_DataAlign = ADC_DataAlign_Right; // 右对齐
    ADC_InitStruct.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None;
    ADC_InitStruct.ADC_Mode = ADC_Mode_Independent; // 独立模式
    ADC_InitStruct.ADC_NbrOfChannel = 1; // 常规序列1个通道
    ADC_InitStruct.ADC_ScanConvMode = DISABLE;
    
    ADC_Init(ADC1, &ADC_InitStruct);

    // #4. 配置常规序列
    ADC_RegularChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_13Cycles5);
    
    ADC_ExternalTrigConvCmd(ADC1, ENABLE);
    
    // #5. 闭合ADC的总开关
    ADC_Cmd(ADC1, ENABLE);
}

void App_OnBoardLED_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOC, &GPIO_InitStruct);
}
```

## 10.5 [ADC]定时器触发

### 连接电路
![](/images/series/stm32/ch10/26.webp)

![](/images/series/stm32/ch10/27.webp)

### 初始化串口
![](/images/series/stm32/ch10/28.webp)

### 配置定时器1的TRGO
![](/images/series/stm32/ch10/29.webp)

### 注入序列的编程接口
| **序号** | **分类** | **编程接口** | **作用** |
| --- | --- | --- | --- |
| **1** | <br/><br/><br/>通用 | ADC_Init | 设置 ADC 的基本参数 |
| **2** | | ADC_Cmd | 总开关 |
| **3** | | ADC_GetFlagStatus | 获取标志位的值 |
| **4** | | ADC_ClearFlag | 清除标志位 |
| **5** | | ADC_ITConfig | 配置中断 |
| **6** | | ADC_DMACmd | 配置 DMA 请求 |
| **7** | | ADC_TempSensorVrefintCmd | 温度计和参考电压开关 |
| **8** | <br/><br/>常规序列 | ADC_RegularChannelConfig | 配置常规序列的通道 |
| **9** | | ADC_ExternalTrigConvCmd | 外部触发开关（常规） |
| **10** | | ADC_SoftwareStartConvCmd | 软件启动（常规） |
| **11** | | ADC_GetConversionValue | 读取 DR 寄存器的值 |
| **12** | <br/><br/><br/>注入序列 | ADC_InjectedSequencerLengthConfig | 设置注入序列的长度 |
| **13** | | ADC_InjectedChannelConfig | 配置注入序列的通道 |
| **14** | | ADC_ExternalTrigInjectedConvCmd | 外部触发开关（注入） |
| **15** | | ADC_ExternalTrigInjectedConvConfig | 选择注入序列的外部触发 |
| **16** | | ADC_SetInjectedOffset | 设置注入序列的通道偏置 |
| **17** | | ADC_SoftwareStartInjectedConvCmd | 软件启动（注入） |
| **18** | | ADC_GetInjectedConversionValue | 读取 JDRx 寄存器的值 |
| **19** | <br/>校准相关 | ADC_ResetCalibration | 复位校准寄存器 |
| **20** | | ADC_GetResetCalibrationStatus | 查询复位是否完成 |
| **21** | | ADC_StartCalibration | 启动校准 |
| **22** | | ADC_GetCalibrationStatus | 查询校准是否完成 |


### 初始化ADC（注入序列）
#### 初始化IO引脚
#### 配置时钟
#### 配置ADC的基本参数
#### 配置注入序列
#### 闭合总开关
### 读取并发送测量结果
![](/images/series/stm32/ch10/30.webp)

#### 完整实验代码
```c
#include "stm32f10x.h"
#include "usart.h"

void App_USART1_Init(void);
void App_TIM1_Init(void);
void App_ADC_Init(void);

int main(void)
{
    App_USART1_Init();
    App_TIM1_Init();
    App_ADC_Init();
    
    while(1)
    {
        // #1. 等待注入序列转换完成
        while(ADC_GetFlagStatus(ADC1, ADC_FLAG_JEOC) == RESET);
        
        // #2. 读取转换的结果
        uint16_t jdr1 = ADC_GetInjectedConversionValue(ADC1, ADC_InjectedChannel_1);
        
        // #3. 清除JEOC标志位
        ADC_ClearFlag(ADC1, ADC_FLAG_JEOC);
        
        // #4. 把结果转换成电压
        float voltage = jdr1 * (3.3f / 4095);
        
        // #5. 通过串口把结果发送出去
        My_USART_Printf(USART1, "%.3f\n", voltage);
    }
}

void App_USART1_Init(void)
{
    // #1. 初始化IO引脚，PA9
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 开启USART1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);

    // #3. 配置串口的参数
    USART_InitTypeDef USART_InitStruct = {0};
    
    USART_InitStruct.USART_BaudRate = 115200;
    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    USART_InitStruct.USART_Mode = USART_Mode_Tx;
    USART_InitStruct.USART_Parity = USART_Parity_No;
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    USART_Init(USART1, &USART_InitStruct);

    // #4. 闭合串口的总开关
    USART_Cmd(USART1, ENABLE);
}

void App_TIM1_Init(void)
{
    // #1. 使能TIM1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_TIM1, ENABLE);
    
    // #2. 配置TIM1的时基单元
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct = {0};
    
    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStruct.TIM_Period = 999;
    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0;

    TIM_TimeBaseInit(TIM1, &TIM_TimeBaseInitStruct);

    // #3. TRGO:Update
    TIM_SelectOutputTrigger(TIM1, TIM_TRGOSource_Update);
    
    // #4. 开启定时器1的总开关
    TIM_Cmd(TIM1, ENABLE);
}

void App_ADC_Init(void)
{
    // #1. 初始化IO引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AIN;	// 模拟模式

    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 配置ADC模块的时钟
    RCC_ADCCLKConfig(RCC_PCLK2_Div6);

    RCC_APB2PeriphClockCmd(RCC_APB2Periph_ADC1, ENABLE);

    // #3. 配置ADC的基本参数
    ADC_InitTypeDef ADC_InitStruct = {0};
    
    ADC_InitStruct.ADC_ContinuousConvMode = DISABLE;
    ADC_InitStruct.ADC_DataAlign = ADC_DataAlign_Right;
    ADC_InitStruct.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None;
    ADC_InitStruct.ADC_Mode = ADC_Mode_Independent;
    ADC_InitStruct.ADC_NbrOfChannel = 1;
    ADC_InitStruct.ADC_ScanConvMode = DISABLE;
    
    ADC_Init(ADC1, &ADC_InitStruct);

    // #4. 配置注入序列的额外参数
    ADC_InjectedSequencerLengthConfig(ADC1, 1);
    
    ADC_ExternalTrigInjectedConvConfig(ADC1, ADC_ExternalTrigInjecConv_T1_TRGO);
    
    ADC_ExternalTrigInjectedConvCmd(ADC1, ENABLE);

    ADC_InjectedChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_13Cycles5);

    // #5. 闭合总开关
    ADC_Cmd(ADC1, ENABLE);
}
```

## 10.6 [ADC]扫描模式

![](/images/series/stm32/ch10/31.webp)

![](/images/series/stm32/ch10/32.webp)

![](/images/series/stm32/ch10/33.webp)

![](/images/series/stm32/ch10/34.webp)

![](/images/series/stm32/ch10/35.webp)

#### 完整实验代码
```c
#include "stm32f10x.h"
#include "usart.h"

void App_USART1_Init(void);
void App_TIM1_Init(void);
void App_ADC1_Init(void);

int main(void)
{
    App_USART1_Init();
    App_TIM1_Init();
    App_ADC1_Init();
    
    while(1)
    {
        // #1. 等待转换完成 JEOC
        while(ADC_GetFlagStatus(ADC1, ADC_FLAG_JEOC) == RESET);
        
        // #2. 把转化的结果读出来
        uint16_t jdr1 = ADC_GetInjectedConversionValue(ADC1, ADC_InjectedChannel_1);
        uint16_t jdr2 = ADC_GetInjectedConversionValue(ADC1, ADC_InjectedChannel_2);
        
        float v1, v2;
        
        v1 = jdr1 * (3.3f / 4095);
        v2 = jdr2 * (3.3f / 4095);
        
        // #3. 把结果通过串口发送出去
        My_USART_Printf(USART1, "%.3f,%.3f\n", v1, v2);
    }
}

void App_USART1_Init(void)
{
    // #1. 初始化IO引脚，PA9 AF_PP
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 开启USART1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    
    // #3. 配置USART1的参数
    USART_InitTypeDef USART_InitStruct = {0};
    
    USART_InitStruct.USART_BaudRate = 115200;
    USART_InitStruct.USART_Mode = USART_Mode_Tx;
    USART_InitStruct.USART_Parity = USART_Parity_No;
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    
    USART_Init(USART1, &USART_InitStruct);

    // #4. 闭合USART1的总开关
    USART_Cmd(USART1, ENABLE);
}

void App_TIM1_Init(void)
{
    // #1. 开启定时器1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_TIM1, ENABLE);

    // #2. 设置时基单元的参数
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct = {0};

    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStruct.TIM_Period = 999;
    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0;

    TIM_TimeBaseInit(TIM1, &TIM_TimeBaseInitStruct);

    // #3. 将TRGO设置为Update模式
    TIM_SelectOutputTrigger(TIM1, TIM_TRGOSource_Update);
    
    // #4. 闭合TIM1的总开关
    TIM_Cmd(TIM1, ENABLE);
}

void App_ADC1_Init(void)
{
    // #1. 初始化IO引脚 PA0 PA1 -> AIN
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0 | GPIO_Pin_1;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AIN;

    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 配置ADC的时钟
    RCC_ADCCLKConfig(RCC_PCLK2_Div6);
    
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_ADC1, ENABLE);

    // #3. 为ADC1初始化基本参数
    ADC_InitTypeDef ADC_InitStruct = {0};
    
    ADC_InitStruct.ADC_ContinuousConvMode = DISABLE;
    ADC_InitStruct.ADC_DataAlign = ADC_DataAlign_Right;
    ADC_InitStruct.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None;
    ADC_InitStruct.ADC_Mode = ADC_Mode_Independent;
    ADC_InitStruct.ADC_NbrOfChannel = 1;
    ADC_InitStruct.ADC_ScanConvMode = ENABLE;
    
    ADC_Init(ADC1, &ADC_InitStruct);

    // #4. 配置注入序列
    ADC_InjectedSequencerLengthConfig(ADC1, 2);
    
    ADC_InjectedChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_13Cycles5);
    ADC_InjectedChannelConfig(ADC1, ADC_Channel_1, 2, ADC_SampleTime_13Cycles5);
    
    ADC_ExternalTrigInjectedConvConfig(ADC1, ADC_ExternalTrigInjecConv_T1_TRGO);
    
    ADC_ExternalTrigInjectedConvCmd(ADC1, ENABLE);
    
    // #5. 闭合ADC总开关
    ADC_Cmd(ADC1, ENABLE);
}
```
