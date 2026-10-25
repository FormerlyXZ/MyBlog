---
title: "第三章 串口：通信协议与 USART 收发"
description: "串口通信协议、USART 模块用法、IO 引脚初始化、发送与接收数据、格式化打印与常用功能封装。"
date: 2026-10-25
image: "/images/series/stm32/ch3/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 3
---
## 3.1 [串口]通信协议

串口 - 通信接口 - 用于传输数据

![](/images/series/stm32/ch3/01.webp)

数据发送的格式，称为通信协议，只有 发送方 和 接收方 的数据格式相同时，数据才可以被接收。

![](/images/series/stm32/ch3/02.webp)

![](/images/series/stm32/ch3/03.webp)

##### 帧组成部分
+ **空闲**：通信线路无数据传输时的状态，通常为高电平。
+ **起始位**：1 位，低电平，用于标志一帧数据的开始。
+ **数据位**：8~9 位，其中最后一位（如 D7）可作为校验位使用。
+ **停止位**：长度可选 0.5、1、1.5、2 位，高电平，用于标志一帧数据的结束。
+ **校验位**：可选，通常占用数据位的最后一位（如 D7），用于数据检错（如奇校验、偶校验）。
    - 奇校验：要求数据位中有奇数个1
    - 偶校验：要求数据位中有偶数个1

## 3.2 [串口]USART模块的使用方法

### USART模块简介

用于接收和发送信息

![](/images/series/stm32/ch2/01.webp)

### USART的基本用法

![](/images/series/stm32/ch3/05.webp)

### 移位寄存器和串并转换

![](/images/series/stm32/ch3/06.webp)

串并转换

* 发送时：将 CPU 输出的并行数据转换为串行比特流，通过单根线传输。
* 接收时：将线路上的串行比特流重新组装为并行数据，供 CPU 读取。

### 数据帧格式的设置方法

![](/images/series/stm32/ch3/07.webp)

### 波特率的设置方法

##### 1. 波特率的产生机制

* **时钟源**：UART 模块的工作时钟来自系统时钟，图中示例为 **32MHz**。
* **两级分频**：
  1. 第一级分频：将 32MHz 时钟先进行 2 分频，得到 **16MHz**。
  2. 第二级分频：由  **波特率寄存器（BRR）** 控制分频系数（图中示例为 ÷16），将 16MHz 进一步分频为 **1MHz**，作为 UART 的波特率时钟。
* **核心寄存器**：波特率寄存器（BRR）是配置波特率的关键，通过写入不同的分频值，即可得到不同的通信速率。

##### 2. 波特率的定义

波特率是指 UART 通信中，**每秒钟传输的比特数（bit/s）**，它直接决定了数据传输的快慢。

##### 3. 波特率与通信参数的关系

波特率需要和通信对端保持一致，同时还需配合以下参数共同决定通信时序：

* 数据位长度（8 位或 9 位）
* 停止位长度（0.5、1、1.5 或 2 位）
* 校验方式（奇校验、偶校验或无校验）

##### 4. 波特率与中断 / 状态标志

UART 模块会根据波特率产生相关的状态标志（如发送完成 TC、接收缓冲区非空 RxNE、校验错误 PE、帧错误 FE、噪声错误 NE、溢出错误 ORE），这些标志可触发中断，用于通知 CPU 数据传输的状态。

![](/images/series/stm32/ch3/08.webp)

### 编程接口

```c
void USART_Init(USART_TypeDef *USARTx,          // 串口名称，如 USART1、USART2 等
                USART_InitTypeDef *USART_InitStruct); // 初始化参数结构体指针
```

**作用**：对指定的串口进行初始化配置。

```c
struct USART_InitTypeDef {
    uint32_t USART_BaudRate;    // 波特率，如 9600、115200 等
    uint16_t USART_WordLength;  // 数据位长度
    uint16_t USART_StopBits;    // 停止位长度
    uint16_t USART_Parity;      // 校验方式
    uint16_t USART_Mode;        // 数据收发方向
};
```

###### （1）数据位长度（<code>USART_WordLength</code>）

* <code>USART_WordLength_8b</code>：8 位数据位
* <code>USART_WordLength_9b</code>：9 位数据位

###### （2）停止位长度（<code>USART_StopBits</code>）

* <code>USART_StopBits_0_5</code>：0.5 位停止位
* <code>USART_StopBits_1</code>：1 位停止位（最常用）
* <code>USART_StopBits_1_5</code>：1.5 位停止位
* <code>USART_StopBits_2</code>：2 位停止位

###### （3）校验方式（<code>USART_Parity</code>）

* <code>USART_Parity_No</code>：无校验（最常用）
* <code>USART_Parity_Even</code>：偶校验
* <code>USART_Parity_Odd</code>：奇校验

###### （4）收发方向（<code>USART_Mode</code>）

* <code>USART_Mode_Tx</code>：仅发送模式
* <code>USART_Mode_Rx</code>：仅接收模式
* <code>USART_Mode_Tx | USART_Mode_Rx</code>：全双工收发模式（最常用）

#### 完整实验代码

```c
#include "stm32f10x.h"

int main(void)
{
    // 开启USART1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);
}
```

## 3.3 [串口]为串口初始化IO引脚

**通信连接规则**：两个设备串口通信时，引脚需**交叉连接**

* 设备 A 的 Tx ↔ 设备 B 的 Rx
* 设备 A 的 Rx ↔ 设备 B 的 Tx

***

### USART模块的引脚

##### 1. 核心通信引脚

* **USARTx_Tx**：发送引脚，负责将芯片内部的并行数据转换为串行比特流，向外发送。
* **USARTx_Rx**：接收引脚，负责从外部线路接收串行比特流，并转换为并行数据供芯片处理。

##### 2. 硬件流控引脚（可选）

* **USARTx_CTS**（Clear To Send）：清除发送，是**输入信号**。由接收设备发送，告知本设备 “我已准备好接收数据，你可以发送了”。
* **USARTx_RTS**（Request To Send）：请求发送，是**输出信号**。由本设备发送，告知接收设备 “我已准备好接收你发来的数据，请你发送”。

##### 3. 同步模式引脚（可选）

* **USARTx_CK**：同步模式下的时钟线，用于在同步通信时提供同步时钟信号（异步 UART 模式下不需要此引脚）。

### STM32 USART1 引脚定位（LQFP48 封装）  

| 引脚编号 | 引脚功能 | 串口角色 |
| --- | --- | --- |
| PA9 | - | USART1_TX（发送） |
| PA10 | - | USART1_RX（接收） |

STM32 提供**复用功能重映射**机制，当 USART1 的默认通信引脚（PA9/Tx、PA10/Rx）被 GPIO、其他外设（如 TIM1、SPI1）占用时，可通过配置将 USART1 的 Tx/Rx 功能转移到**备用引脚**，保证串口通信正常。上述重映射引脚（PB6/PB7）仅适用于 LQFP48 封装的 STM32（如 F103C8T6），其他封装（如 LQFP64）需查阅对应数据手册

![](/images/series/stm32/ch3/09.webp)

### 重映射表

![](/images/series/stm32/ch3/10.webp)

### IO配置表

##### 一、USART 引脚与 GPIO 配置表

| USART 引脚 | 工作模式 | GPIO 配置 |
| --- | --- | --- |
| USARTx_TX | 全双工模式 | 推挽复用输出（`GPIO_Mode_AF_PP`） |
| USARTx_TX | 半双工同步模式 | 推挽复用输出（`GPIO_Mode_AF_PP`） |
| USARTx_RX | 全双工模式 | 浮空输入或带上拉输入（`GPIO_Mode_IN_FLOATING` / `GPIO_Mode_IPU`） |
| USARTx_RX | 半双工同步模式 | 未用，可作为通用 I/O |
| USARTx_CK | 同步模式 | 推挽复用输出（`GPIO_Mode_AF_PP`） |
| USARTx_RTS | 硬件流量控制 | 推挽复用输出（`GPIO_Mode_AF_PP`） |
| USARTx_CTS | 硬件流量控制 | 浮空输入或带上拉输入（`GPIO_Mode_IN_FLOATING` / `GPIO_Mode_IPU`） |

##### 二、USART 通信模式与连接方式

1. **全双工模式**
   * 同时支持收发，Tx 和 Rx 交叉连接：
     * 本设备 Tx → 对端 Rx
     * 本设备 Rx → 对端 Tx
   * 对应引脚：Tx（推挽复用输出）、Rx（浮空 / 上拉输入）
2. **半双工同步模式**
   * 仅使用 Tx 线，单向传输，Rx 引脚未用，可作为普通 GPIO。
   * 连接方式：本设备 Tx → 对端 Tx
3. **同步模式**
   * 除 Tx、Rx 外，还需 CK 时钟线提供同步时钟。
   * 连接方式：Tx、Rx 交叉连接，同时本设备 CK → 对端 CK
4. **硬件流控模式**
   * 增加 CTS、RTS 引脚用于流量控制，需交叉连接：
     * 本设备 RTS → 对端 CTS
     * 本设备 CTS ← 对端 RTS
   * 对应引脚：RTS（推挽复用输出）、CTS（浮空 / 上拉输入）

### 编写代码（默认 PA9 PA10）

```c
#include "stm32f10x.h"

int main(void)
{
    // 同时开启USART1和GPIOA的时钟（APB2总线，可合并调用）
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1 | RCC_APB2Periph_GPIOA, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // Tx PA9 复用输出推挽
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    
    // Rx PA10 输入上拉（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_10;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);

    // 死循环（避免程序退出）
    while(1);
}
```

### 编写代码（重映射 PB6 PB7）

```c
#include "stm32f10x.h"

int main(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );

    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);
    
    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);

    // 死循环（避免程序退出）
    while(1);
}
```

## 3.4 [串口]发送数据

![](/images/series/stm32/ch3/11.webp)

### TxE标志位

##### 1. 全称与含义

* **TxE**：Transmit Data Register Empty（发送数据寄存器空）
* 作用：指示 USART 的 **发送数据寄存器（TDR）** 是否为空，是判断能否写入新数据的关键标志。

##### 2. 状态规则

* 当 TDR 为空（无待发送数据）时，硬件自动将 TxE 置为 **1**（Bit_SET）；
* 当 CPU 向 TDR 写入新数据后，硬件自动将 TxE 清为 **0**（Bit_RESET）。

##### 3. 作用

在串口发送数据时，需先检查 TxE 标志，确保 TDR 为空后再写入数据，防止新写入的数据将原来待发送的数据覆盖。

### TC标志位

##### 1. 全称与含义

* **TC**：Transmit Complete（发送完成）
* 作用：指示 USART 的**发送数据寄存器（TDR）和移位寄存器均为空**，即一帧数据已经完全从硬件上发送到线路上，是判断 “数据是否真正发送完毕” 的关键标志。

##### 2. 状态规则

* 当**TDR 为空**且**移位寄存器也为空**（所有数据都已移出）时，硬件自动将 TC 置为 **1**（Bit_SET）；
* 当 CPU 向 TDR 写入新数据后，硬件自动将 TC 清为 **0**（Bit_RESET）。

##### 3. 与 TxE 的核心区别

| 标志位 | 判断条件 | 应用场景 |
| --- | --- | --- |
| TxE | 仅判断 TDR 是否为空 | 用于 “写入下一个字节”，避免覆盖未写入的数据 |
| TC | 判断 TDR 和移位寄存器都为空 | 用于 “确认数据真正发送到线路上”，如进入低功耗前必须确认发送完成 |

##### 4. 应用

在需要确保数据完全发送后再执行后续操作（如关闭串口、进入停止模式）时，需检查 TC 标志

### 编程接口

#### USART_Cmd 函数笔记

##### 1. 函数声明

```c
void USART_Cmd(USART_TypeDef *USARTx, FunctionalState NewState);
```

##### 2. 参数说明

* **USARTx**：指定要操作的串口，如 <code>USART1</code>、<code>USART2</code> 等。
* **NewState**：控制 USART 的使能 / 禁止状态：
  * <code>ENABLE</code>：使能 USART 模块，使其可以收发数据；
  * <code>DISABLE</code>：禁止 USART 模块，使其停止工作。

##### 3. 作用

<code>USART_Cmd</code> 是 USART 模块的**总开关**，用于控制整个串口模块的工作状态。

* 使能后，USART 的发送 / 接收电路、移位寄存器、状态标志（TxE、TC、RxNE 等）和中断才能正常工作；
* 禁止后，USART 模块停止工作，所有相关功能失效。

##### 4. 关键注意事项

* USART 初始化（<code>USART_Init</code>）后，必须调用 <code>USART_Cmd(USARTx, ENABLE)</code> 才能使串口真正工作；
* 进入低功耗模式前，可调用 <code>USART_Cmd(USARTx, DISABLE)</code> 关闭串口以节省功耗；
* 该函数控制的是整个 USART 模块，而非单个引脚或通道。

#### USART_GetFlagStatus 函数笔记

##### 1. 函数声明

```c
FlagStatus USART_GetFlagStatus(USART_TypeDef *USARTx, uint16_t USART_FLAG);
```

##### 2. 参数说明

* **USARTx**：指定要操作的串口，如 <code>USART1</code>、<code>USART2</code> 等。
* **USART_FLAG**：指定要查询的标志位，常用标志位包括：
  * <code>USART_FLAG_TXE</code>：发送数据寄存器空（TxE）
  * <code>USART_FLAG_RXNE</code>：接收数据寄存器非空（RxNE）
  * <code>USART_FLAG_TC</code>：发送完成（TC）
  * <code>USART_FLAG_PE</code>：校验错误（PE）
  * <code>USART_FLAG_FE</code>：帧错误（FE）
  * <code>USART_FLAG_NE</code>：噪声错误（NE）
  * <code>USART_FLAG_ORE</code>：溢出错误（ORE）

##### 3. 返回值

* <code>RESET</code>（0）：标志位为 0，条件不满足；
* <code>SET</code>（1）：标志位为 1，条件满足。

##### 4. 作用

用于查询 USART 的各种状态标志位，判断当前串口的工作状态，是串口收发数据、错误检测的核心接口。

##### 5. 示例代码

```c
// 判断发送数据寄存器（TDR）是否为空，可写入新数据
if(USART_GetFlagStatus(USART1, USART_FLAG_TXE) == SET)
{
    // TDR为空，写入新数据
    USART_SendData(USART1, 'A');
}

// 判断一帧数据是否完全发送到线路上（发送完成）
if(USART_GetFlagStatus(USART1, USART_FLAG_TC) == SET)
{
    // 数据发送完成，可执行后续操作（如进入低功耗）
}
```

#### USART_SendData 函数笔记

##### 1. 函数声明

```c
void USART_SendData(USART_TypeDef *USARTx, uint16_t Data);
```

##### 2. 参数说明

* **USARTx**：指定要操作的串口，如 <code>USART1</code>、<code>USART2</code> 等。
* **Data**：要发送的数据，虽然参数类型是 <code>uint16_t</code>，但在 8 位数据位模式下，仅使用**低 8 位**（高 8 位无效）。

##### 3. 作用

将待发送的数据写入 USART 的**发送数据寄存器（TDR）**，硬件会自动将数据从 TDR 加载到移位寄存器，并按波特率逐位发送到 Tx 线路上。

##### 4. 典型使用示例（含 TxE 检查，避免覆盖数据）  

```c
// 等待发送数据寄存器（TDR）为空（TxE=1）
while(USART_GetFlagStatus(USART1, USART_FLAG_TXE) == RESET);
// 向TDR写入数据，启动发送
USART_SendData(USART1, 0x01); // 发送字节 0x01
```

##### 5. 关键注意事项

* 写入 TDR 后，硬件会自动将 TxE 标志清 0，移位寄存器开始发送数据；
* 若需确保数据完全发送到线路上，需额外检查 TC 标志（<code>USART_FLAG_TC</code>）；
* 该函数仅负责 “写入数据到 TDR”，不等待发送完成，需配合状态标志位使用。

### 编写代码

#### 自定义函数模块

```c
// @作用: 使用串口一次性发送多个字节
// @参数: pData - 要发送的数据；Size - 字节的数量
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size)
{
    for(uint32_t i = 0; i < Size; i++)
    {
        // #1. 等待发送数据寄存器空（TxE=1）
        while(USART_GetFlagStatus(USARTx, USART_FLAG_TXE) == RESET);
        // #2. 将数据写入发送数据寄存器，启动发送
        USART_SendData(USARTx, pData[i]);
    }
    // #3. 等待所有数据完全发送到线路上（TC=1）
    while(USART_GetFlagStatus(USARTx, USART_FLAG_TC) == RESET);
}
```

#### 完整实验代码

```c
#include "stm32f10x.h"

// 函数声明
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size);

int main(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);

    // 发送数据
    uint8_t bytesToSend[] = {1, 2, 3, 4, 5};
    My_USART_SendBytes(USART1, bytesToSend, 5);

    // 死循环（避免程序退出）
    while(1);
}

// 函数实现
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size)
{
    for(uint32_t i = 0; i < Size; i++)
    {
        // #1. 等待发送数据寄存器空（TxE=1）
        while(USART_GetFlagStatus(USARTx, USART_FLAG_TXE) == RESET);
        // #2. 将数据写入发送数据寄存器，启动发送
        USART_SendData(USARTx, pData[i]);
    }
    // #3. 等待所有数据完全发送到线路上（TC=1）
    while(USART_GetFlagStatus(USARTx, USART_FLAG_TC) == RESET);
}
```

#### 连接电路

![](/images/series/stm32/ch3/12.webp)

#### 下载串口调试助手

![](/images/series/stm32/ch3/13.webp)

## 3.5 [串口]格式化打印字符串

### 重写代码

```c
#include "stm32f10x.h"

// 函数声明
/* 
   简介 通过串口发送字节
   参数 USARTx: 填写串口名称
   参数 pData: 需要发送的数据
   参数 Size: 发送数据的数量，单位字节
*/
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size);
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();
    
    // 发送数据
    uint8_t bytesToSend[] = {1, 2, 3, 4, 5};
    My_USART_SendBytes(USART1, bytesToSend, 5);

    // 死循环（避免程序退出）
    while(1);
}

// 函数实现
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size)
{
    for(uint32_t i = 0; i < Size; i++)
    {
        // #1. 等待发送数据寄存器空（TxE=1）
        while(USART_GetFlagStatus(USARTx, USART_FLAG_TXE) == RESET);
        // #2. 将数据写入发送数据寄存器，启动发送
        USART_SendData(USARTx, pData[i]);
    }
    // #3. 等待所有数据完全发送到线路上（TC=1）
    while(USART_GetFlagStatus(USARTx, USART_FLAG_TC) == RESET);
}

void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```

### 格式化字符串的编程原理

#### 一、常规 printf 的执行流程

1. **格式化字符串生成**：<code>printf</code>根据格式控制符（如<code>%s</code>）拼接出完整字符串（例：<code>Hi, Tom! Nice to meet you! \r\n</code>）。
2. **底层输出**：通过库函数<code>fputc</code>将格式化后的字符逐个发送到控制台。

#### 二、重定向核心：重写<code>fputc</code>弱函数

##### 1. 原函数特性

库中<code>fputc</code>为**弱函数（_weak）**，默认实现是将字符发送到控制台，原型：

```c
_weak int fputc(int ch, FILE *f)
{
    // 发送到控制台
}
```

##### 2. 重写逻辑

通过**重写**<code>**fputc**</code>，替换原逻辑为**通过串口发送字符**，原型修改为：

```c
int fputc(int ch, FILE *f)
{
    // 通过串口发送出去
}
```

```c
// 定义字符串
const char *strName = "Tom";
// 格式化输出（底层会调用fputc）
printf("Hi, %s! Nice to meet you! \r\n", strName);
```

### 重写 fputc 函数

```c
#include "stdio.h"

int fputc(int ch, FILE *f)
{
    // #1. 等待发送数据寄存器为空
    while(USART_GetFlagStatus(USART1, USART_FLAG_TXE) == RESET);
    // #2. 写入数据寄存器当中
    USART_SendData(USART1, (uint8_t)ch);
    return ch;
}
```

#### 测试代码

```c
#include "stm32f10x.h"
#include "stdio.h"

// 函数声明
/* 
   简介 通过串口发送字节
   参数 USARTx: 填写串口名称
   参数 pData: 需要发送的数据
   参数 Size: 发送数据的数量，单位字节
*/
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size);
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();
    
    printf("hello world");

    // 死循环（避免程序退出）
    while(1);
}

// 函数实现
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size)
{
    for(uint32_t i = 0; i < Size; i++)
    {
        // #1. 等待发送数据寄存器空（TxE=1）
        while(USART_GetFlagStatus(USARTx, USART_FLAG_TXE) == RESET);
        // #2. 将数据写入发送数据寄存器，启动发送
        USART_SendData(USARTx, pData[i]);
    }
    // #3. 等待所有数据完全发送到线路上（TC=1）
    while(USART_GetFlagStatus(USARTx, USART_FLAG_TC) == RESET);
}

void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}

int fputc(int ch, FILE *f)
{
    // #1. 等待发送数据寄存器为空
    while(USART_GetFlagStatus(USART1, USART_FLAG_TXE) == RESET);
    // #2. 写入数据寄存器当中
    USART_SendData(USART1, (uint8_t)ch);
    return ch;
}
```

### 格式化时间字符串

```c
uint32_t currentTick = GetTick(); // 获取当前的时间，GetTick是已封装好的函数

// 对1000取余得到毫秒
uint32_t miliseconds = currentTick % 1000; 
// 1000取整
currentTick /= 1000;
// 重复以上操作，得到秒，分钟，小时
uint32_t seconds = currentTick % 60;       currentTick /= 60;
uint32_t minute  = currentTick % 60;       currentTick /= 60;
uint32_t hour    = currentTick;

printf("%02u:%02u:%02u.%03u\r\n", hour, minute, seconds, miliseconds);
```

#### 完整实验代码

```c
#include "stm32f10x.h"
#include "stdio.h"
#include "delay.h"

// 函数声明
/* 
   简介 通过串口发送字节
   参数 USARTx: 填写串口名称
   参数 pData: 需要发送的数据
   参数 Size: 发送数据的数量，单位字节
*/
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size);
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    Delay_Init();
    My_USART1_Init();
    
    printf("hello world");

    // 死循环（避免程序退出）
    while(1)
    {
        uint32_t currentTick = GetTick(); // 获取当前的时间，GetTick是已封装好的函数

        uint32_t miliseconds = currentTick % 1000; currentTick /= 1000;
        uint32_t seconds = currentTick % 60;       currentTick /= 60;
        uint32_t minute  = currentTick % 60;       currentTick /= 60;
        uint32_t hour    = currentTick;

        printf("%02u:%02u:%02u.%03u\r\n", hour, minute, seconds, miliseconds);

        // 每隔100ms打印一次
        Delay(100);
    }
}

// 函数实现
void My_USART_SendBytes(USART_TypeDef *USARTx, uint8_t *pData, uint16_t Size)
{
    for(uint32_t i = 0; i < Size; i++)
    {
        // #1. 等待发送数据寄存器空（TxE=1）
        while(USART_GetFlagStatus(USARTx, USART_FLAG_TXE) == RESET);
        // #2. 将数据写入发送数据寄存器，启动发送
        USART_SendData(USARTx, pData[i]);
    }
    // #3. 等待所有数据完全发送到线路上（TC=1）
    while(USART_GetFlagStatus(USARTx, USART_FLAG_TC) == RESET);
}

void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}

int fputc(int ch, FILE *f)
{
    // #1. 等待发送数据寄存器为空
    while(USART_GetFlagStatus(USART1, USART_FLAG_TXE) == RESET);
    // #2. 写入数据寄存器当中
    USART_SendData(USART1, (uint8_t)ch);
    return ch;
}
```

## 3.6 [串口]接收数据

### RxNE 标志位

* **标志位名称**：RxNE（Receive Data Register Not Empty）
* **中文含义**：接收数据寄存器非空
* **功能说明**：当接收数据寄存器（RDR）中存在未被读取的数据时，RxNE 标志位被硬件置为 1；当 RDR 为空时，RxNE 标志位为 0。

### 接收代码的编写方法

#### USART 接收数据函数笔记

* **函数原型**：<code>uint16_t USART_ReceiveData(USARTTypeDef *USARTx);</code>
* **参数说明**：<code>USARTx</code> 为串口名称（如 USART1、USART2 等）
* **函数作用**：从 USART 的接收数据寄存器（RDR）中读取接收到的数据

```c
// #1. 等待接收数据寄存器非空
while(USART_GetFlagStatus(USARTx, USART_FLAG_RXNE) == RESET);

// #2. 接收数据
uint8_t btyeRcvd = USART_ReceiveData(USARTx);

// #3. 处理数据
...
```

### 使用串口控制 LED

#### 完整实验代码

```c
#include "stm32f10x.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数
// 初始化板载LED灯
void My_OnBoardLED_Init(void);

int main(void)
{
    My_USART1_Init();
    My_OnBoardLED_Init();

    // 死循环（避免程序退出）
    while(1) 
    {
        // #1. 等待接收数据寄存器RDR非空
        while(USART_GetFlagStatus(USART1, USART_FLAG_RXNE) == RESET);
        
        // #2. 读取数据
        uint8_t byteRcvd = USART_ReceiveData(USART1);
        
        // #3. 对数据进行处理
        if(byteRcvd == '0')
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET); // 灭灯
        else if(byteRcvd == '1')
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET); // 亮灯
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}

void My_OnBoardLED_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);
    
    GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
}
```

### 错误标志位

| 标志位 | 英文全称 | 中文含义 | 触发条件 |
| --- | --- | --- | --- |
| **PE** | Parity Error | 奇偶校验错误 | 当接收数据的奇偶校验位与配置的校验模式不匹配时，该标志位置 1。 |
| **FE** | Framing Error | 帧错误 | 检测到接收数据的停止位不正确（缺失或电平错误）时，该标志位置 1。 |
| **NE** | Noise Error | 噪声错误 | 检测到接收信号中存在噪声干扰，导致采样值异常时，该标志位置 1。 |
| **ORE** | Overrun Error | 溢出错误 | 前一个接收数据还未被读取，新的数据又到达接收寄存器时，该标志位置 1。 |

## 3.7 [串口]封装常用功能

### MyLib 文件夹简介

自己封装的库。

.c是原文件，.h是头文件。

### 串口发送相关的函数

将鼠标放在函数上，点击键盘上端的F12，跳转到函数的封装界面。

| 函数原型 | 功能说明 |
| --- | --- |
| `void My_USART_SendByte(...);` | 发送一个字节 |
| `void My_USART_SendBytes(...);` | 发送多个字节 |
| `void My_USART_SendChar(...);` | 发送一个字符 |
| `void My_USART_SendString(...);` | 发送字符串 |
| `void My_USART_Printf(...);` | 发送格式化字符串 |

#### My_USART_SendByte

```c
#include "stm32f10x.h"
#include "usart.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();
    My_USART_SendByte(USART1, 0x5a);

    // 死循环（避免程序退出）
    while(1) 
    {
        
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```

#### My_USART_SendBytes

```c
#include "stm32f10x.h"
#include "usart.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();
    // My_USART_SendByte(USART1, 0x5a);
    uint8_t byteArray[] = {1, 2, 3, 4, 5};
    My_USART_SendBytes(USART1, byteArray, 5);

    // 死循环（避免程序退出）
    while(1) 
    {
        
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```

#### My_USART_SendChar

```c
#include "stm32f10x.h"
#include "usart.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();

    My_USART_SendChar(USART1, 'a');

    // 死循环（避免程序退出）
    while(1) 
    {
        
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```

#### My_USART_SendString

```c
#include "stm32f10x.h"
#include "usart.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();

    My_USART_SendString(USART1, "Hello World. \r\n");

    // 死循环（避免程序退出）
    while(1) 
    {
        
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```

#### My_USART_Printf

```c
#include "stm32f10x.h"
#include "usart.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();

    const char *strName = "Tom";
    My_USART_Printf(USART1, "Hi, %s! Nice to meet you! \r\n", strName);

    // 死循环（避免程序退出）
    while(1) 
    {
        
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```

### 串口接收相关的函数

| 函数原型 | 功能说明 |
| --- | --- |
| `... My_USART_ReceiveByte(...);` | 接收一个字节 |
| `... My_USART_ReceiveBytes(...);` | 接收多个字节 |
| `... My_USART_ReceiveLine(...);` | 接收一行字符串 |

#### My_USART_ReceiveByte

```c
#include "stm32f10x.h"
#include "usart.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();

    GPIO_InitTypeDef GPIO_InitStruct;
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);

    // 死循环（避免程序退出）
    while(1) 
    {
        char c = My_USART_ReceiveByte(USART1);
        if(c == '0')
        {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
        }
        else if(c == '1')
        {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
        }
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```

#### My_USART_ReceiveBytes

```c
```

#### My_USART_ReceiveLine

```c
#include "stm32f10x.h"
#include "usart.h"

// 函数声明
/* 
   简介 对USART1进行初始化
   PB6 - Tx
   PB7 - Rx
   波特率115200，8位校验位，1位停止位，无校验位，数据收发方向：双向
*/
void My_USART1_Init(void);	// 将初始化操作封装成函数

int main(void)
{
    My_USART1_Init();

    // 死循环（避免程序退出）
    while(1) 
    {
        char buffer[100];

        if(My_USART_ReceiveLine(USART1, buffer, 100, LINE_SEPERATOR_CRLF, -1) == 0)
        {
            My_USART_SendString(USART1, buffer);
        }
    }
}

// 函数实现
void My_USART1_Init(void)
{
    // 同时开启时钟
    RCC_APB2PeriphClockCmd(
        RCC_APB2Periph_USART1 |  // USART1时钟
        RCC_APB2Periph_AFIO |    // 重映射必须开启AFIO时钟
        RCC_APB2Periph_GPIOB,    // GPIOB时钟（PB6/PB7）
        ENABLE
    );
    
    // 定义USART初始化结构体
    USART_InitTypeDef USART_InitStruct;

    // 配置USART1重映射：USART1_REMAP=1，将TX/RX从PA9/PA10切换到PB6/PB7，必须在GPIO初始化前
    GPIO_PinRemapConfig(GPIO_Remap_USART1, ENABLE);

    // 定义GPIO初始化结构体
    GPIO_InitTypeDef GPIO_InitStruct;

    // 配置PB6（USART1_TX）：复用推挽输出
    GPIO_InitStruct.GPIO_Pin   = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode  = GPIO_Mode_AF_PP; // 复用推挽输出模式
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz; // 最大输出速度
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置PB7（USART1_RX）：上拉输入（也可配置为浮空输入）
    GPIO_InitStruct.GPIO_Pin  = GPIO_Pin_7;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOB, &GPIO_InitStruct);
    
    // 配置波特率为115200
    USART_InitStruct.USART_BaudRate = 115200;
    // 配置为收发双向模式
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    // 配置数据位长度为8位
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    // 配置无校验位
    USART_InitStruct.USART_Parity = USART_Parity_No;
    // 配置停止位为1位
    USART_InitStruct.USART_StopBits = USART_StopBits_1;

    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;	// 无硬件流控
    
    // 初始化USART1
    USART_Init(USART1, &USART_InitStruct);

    // USART1 配置后必须显式使能，否则串口处于禁用状态
    USART_Cmd(USART1, ENABLE);
}
```
