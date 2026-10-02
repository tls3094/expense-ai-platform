import { createClient } from "@supabase/supabase-js";

const PROJECT_PERIOD = "2026. 3. 1. ~ 2027. 2. 28.";
const RECEIVER_NAME = "경남정보대학교 산학협력단";
const WITNESS_DEPARTMENT = "비교과혁신센터";
const WITNESSES = ["정현서", "이경연", "추현정"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function fallbackResult(message) {
  return {
    status: "보완 요청",
    score: 0,
    summary: message,
    checked: [],
    missing_or_unclear: [
      "[담당자 확인 필요] AI 검토 처리 중 확인이 필요한 문제가 발생했습니다."
    ],
    findings: [
      {
        type: "담당자 확인 필요",
        title: "AI 검토 처리 오류",
        detail: message,
        related_documents: []
      }
    ],
    document_summary: [],
    caution: "최종 지급 승인 전 담당자가 원본 증빙서류를 직접 확인해야 합니다."
  };
}

function normalizeResult(result) {
  return {
    status: result.status === "AI 검수 완료"
      ? "AI 검수 완료"
      : "보완 요청",
    score: Math.max(0, Math.min(100, Number(result.score || 0))),
    summary: result.summary || "AI 검토 요약이 없습니다.",
    checked: Array.isArray(result.checked) ? result.checked : [],
    missing_or_unclear: Array.isArray(result.missing_or_unclear)
      ? result.missing_or_unclear
      : [],
    findings: Array.isArray(result.findings) ? result.findings : [],
    document_summary: Array.isArray(result.document_summary)
      ? result.document_summary
      : [],
    caution: result.caution ||
      "최종 지급 승인 전 담당자가 원본 증빙서류를 직접 확인해야 합니다."
  };
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ error: "POST 요청만 가능합니다." }, 405);
  }

  try {
   
    const { requestId } = await request.json();

    if (!requestId) {
      return json({ error: "신청서 ID가 없습니다." }, 400);
    }

    const { data: application, error: applicationError } = await supabase
      .from("expense_requests")
      .select(`
        *,
        expense_files (
          id,
          document_name,
          original_name,
          storage_path,
          file_size,
          mime_type
        )
      `)
      .eq("id", requestId)
      .single();

    if (applicationError || !application) {
      return json({ error: "신청서를 찾을 수 없습니다." }, 404);
    }

   
    const files = application.expense_files || [];

    if (!files.length) {
      const result = {
        status: "보완 요청",
        score: 0,
        summary: "첨부된 증빙서류가 없어 AI 검토를 진행할 수 없습니다.",
        checked: [],
        missing_or_unclear: [
          "[누락] AI 검토 대상 증빙서류가 첨부되지 않았습니다."
        ],
        findings: [
          {
            type: "누락",
            title: "첨부파일 없음",
            detail: "증빙서류를 첨부한 후 다시 AI 검수 요청을 진행하세요.",
            related_documents: []
          }
        ],
        document_summary: [],
        caution: "최종 지급 승인 전 담당자가 원본 증빙서류를 확인해야 합니다."
      };

      await supabase
        .from("expense_requests")
        .update({
          status: "보완 요청",
          ai_result: result,
          updated_at: new Date().toISOString()
        })
        .eq("id", requestId);

      return json(result);
    }

    const inputFiles = [];
    const skippedFiles = [];

    for (const file of files.slice(0, 20)) {
      if (Number(file.file_size || 0) > 12 * 1024 * 1024) {
        skippedFiles.push(
          `${file.original_name}: 파일 크기가 12MB를 초과하여 분석에서 제외되었습니다.`
        );
        continue;
      }

      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from("expense-files")
        .createSignedUrl(file.storage_path, 900);

      if (signedUrlError || !signedUrlData?.signedUrl) {
        skippedFiles.push(
          `${file.original_name}: 파일 접근 URL 생성에 실패했습니다.`
        );
        continue;
      }

      const fileResponse = await fetch(signedUrlData.signedUrl);

      if (!fileResponse.ok) {
        skippedFiles.push(
          `${file.original_name}: 파일 다운로드에 실패했습니다.`
        );
        continue;
      }

      const arrayBuffer = await fileResponse.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      inputFiles.push({
        type: "input_file",
        filename: file.original_name,
        file_data: `data:${file.mime_type || "application/pdf"};base64,${base64}`
      });
    }

    const prompt = `
당신은 경남정보대학교 혁신지원사업 지출 증빙서류 AI 1차 검토자입니다.

반드시 실제 첨부파일에서 읽히는 내용만 사용하십시오.

중요 원칙:
1. 글자, 날짜, 금액, 사업코드, 계좌번호, 서명, 직인이 흐리거나 일부 가려져 정확히 확인할 수 없으면 추정하지 말고 반드시 [담당자 확인 필요]로 처리합니다.
2. 서명, 직인, 도장의 위조 여부 또는 진위는 절대 판단하지 않습니다.
3. 서명·직인·도장이 문서에 형식적으로 존재하는지만 확인합니다.
4. 문서에 없는 정보는 임의로 만들지 않습니다.
5. 강사의 경력, 직위, 강사등급을 서류로 확정할 수 없으면 [담당자 확인 필요]로 처리합니다.
6. [오류], [누락], [보완 필요] 중 하나라도 있으면 상태는 "보완 요청"입니다.
7. [담당자 확인 필요]만 있다면 상태는 "AI 검수 완료"로 설정할 수 있습니다.

고정 사업기간:
${PROJECT_PERIOD}

플랫폼 신청 정보:
- 접수번호: ${application.receipt_no}
- 신청자: ${application.applicant_name}
- 사업명: ${application.business_name}
- 프로그램: ${application.program_type}
- 사업코드: ${application.program_code}
- 세부사업명: ${application.program_name}
- 담당교수: ${application.assigned_professor}
- 학과: ${application.department}
- 집행비목: ${application.expense_category}
- 세부집행항목: ${application.expense_sub_item}
- 플랫폼 입력 총 신청금액: ${application.total_amount}원
- 요구서류: ${(application.expected_documents || []).join(", ")}
- 비고: ${application.memo || "없음"}

반드시 검토할 항목:

1. 사업기간
- 모든 문서 날짜가 ${PROJECT_PERIOD} 범위에 적합한지 확인합니다.
- 날짜가 읽기 어렵거나 불명확하면 [담당자 확인 필요]입니다.

2. 사업코드
- 모든 제출서류의 사업코드가 ${application.program_code}와 동일한지 확인합니다.
- 사업코드가 없으면 [누락].
- 다른 사업코드면 [오류].
- 글자가 불분명하면 [담당자 확인 필요].
- 서류끼리 사업코드가 서로 다르면 [오류].

3. 견적서 날짜
- 견적서 날짜는 일반구매요구서 날짜보다 같거나 빨라야 합니다.
- 견적서 날짜 > 일반구매요구서 날짜이면 [오류].
- 날짜가 읽기 어려우면 [담당자 확인 필요].

4. 견적서 개수
- 총금액 50만 원 미만이면 본견적서 1부가 필요합니다.
- 총금액 50만 원 이상이면 본견적서와 타견적서가 필요합니다.
- 50만 원 이상인데 타견적서가 없으면 [누락].
- 본견적서와 타견적서 구분이 애매하면 [담당자 확인 필요].

5. 수신처 확인
- 견적서, 거래명세서, 전자세금계산서 수신처/공급받는 자는 "${RECEIVER_NAME}"이어야 합니다.
- 다르면 [오류], 없으면 [누락], 판독 불가면 [담당자 확인 필요].

6. 날짜 일치 확인
- 전자세금계산서 날짜 = 거래명세서 날짜 = 물품검수조서 검수년월일이어야 합니다.
- 다르면 [오류].

7. 물품검수조서 날짜
- 계약체결년월일 = 일반구매요구서 날짜인지 확인합니다.
- 납품기한, 검수년월일, "위와 같이 검수하였음" 아래 날짜는 실제 물건 도착일 기준으로 확인합니다.
- 실제 도착일을 서류만으로 판단할 수 없으면 [담당자 확인 필요].

8. 물품검수조서 신청자·검수자
- 소속은 "${application.department}"이어야 합니다.
- 성명은 "${application.assigned_professor}"이어야 합니다.
- 다르면 [오류], 없으면 [누락], 판독 불가면 [담당자 확인 필요].

9. 물품검수조서 입회인
- 소속은 "${WITNESS_DEPARTMENT}"이어야 합니다.
- 성명은 ${WITNESSES.join(", ")} 중 1명이어야 합니다.
- 다른 값이면 [오류], 공란이면 [누락], 판독 불가면 [담당자 확인 필요].

10. 물품검수조서 사진
- 물품 사진 첨부 여부를 확인합니다.
- 없으면 [누락].
- 사진 식별이 어렵다면 [담당자 확인 필요].

11. 수용비 인쇄배부계획서
- 인쇄수량이 10부 미만이면 인쇄배부계획서는 불필요합니다.
- 인쇄수량이 10부 이상이면 인쇄배부계획서가 필요합니다.
- 10부 이상인데 계획서가 없으면 [누락].
- 인쇄수량을 읽을 수 없으면 [담당자 확인 필요].

12. 단체식대
- 참여학생명단이 실제 서명된 명단인지 확인합니다.
- 단순 명단만 있고 서명이 없으면 [보완 필요].
- 서명 존재 여부가 불확실하면 [담당자 확인 필요].

13. 금액 교차검토
- 플랫폼 입력금액, 일반구매요구서, 견적서, 거래명세서, 전자세금계산서, 영수증, 지급신청서 금액을 비교합니다.
- 같은 건의 금액이 다르면 [오류].
- 공급가액, 부가세, 합계 구분이 불명확하면 [담당자 확인 필요].

14. 특강료 / 강사료
- 강사 경력, 직위, 강사등급, 시간당 단가, 강의시간, 지급금액을 확인합니다.
- 시간당 단가 × 강의시간 = 지급금액인지 계산합니다.
- 계산이 맞지 않으면 [오류].
- 경력·등급을 확정할 수 없으면 [담당자 확인 필요].

15. 계좌번호
- 기술정보활동비 지급신청서 계좌번호와 통장사본 계좌번호가 동일한지 확인합니다.
- 다르면 [오류].
- 마스킹 또는 판독불가로 비교할 수 없으면 [담당자 확인 필요].

16. 외부강사 서류 일치
- 재직증명서, 기술정보활동비 지급신청서, 비정기강의계획서, 개인정보 제공·활용 동의서에 적힌 강사 성명·소속이 같은지 확인합니다.
- 개인정보 제공·활용 동의서에 서명이 있는지 확인합니다.
- 성명·소속 불일치면 [오류].
- 동의서 서명이 없으면 [누락].
- 경력 2년 이상 여부를 확정하기 어려우면 [담당자 확인 필요].

17. 참여 인원
- 단체식대뿐 아니라 다과비 등 인원 기준 지급 비목도 참여학생명단 인원과 지급 산정 인원이 일치해야 합니다.
- 다르면 [오류].
- 인원 판독 불가면 [담당자 확인 필요].

18. 현장견학
- 현장견학 서류일 때만 적용합니다.
- 차량 임차 서류 수신처는 "${RECEIVER_NAME}"이어야 합니다.
- 입장료는 학생 인원 기준인지 확인합니다.
- 방문 목적지가 문서에 있는지 확인합니다.
- 하루 한 끼면 1인 금액이 15,000원을 넘으면 [오류].
- 하루 두 끼 이상이면 끼니당 1인 금액이 25,000원 이상이면 [오류].
- 하루 1인 식대 합계가 30,000원을 넘으면 [오류].
- 날짜별 식대·끼니·인원이 불명확하면 [담당자 확인 필요].

19. 작성 주체 및 직인
- 일반구매요구서와 지급신청서에 담당교수 "${application.assigned_professor}"의 서명 또는 직인이 형식적으로 존재하는지 확인합니다.
- 없으면 [누락].
- 진위 여부는 판단하지 않습니다.
- 존재 여부가 애매하면 [담당자 확인 필요].

AI 분석 제외 또는 접근 실패 파일:
${skippedFiles.length ? skippedFiles.join("\n") : "없음"}

반드시 아래 JSON 형식만 반환하십시오.

{
  "status": "AI 검수 완료 또는 보완 요청",
  "score": 0,
  "summary": "전체 검토 요약",
  "checked": ["정상 확인 항목"],
  "missing_or_unclear": ["핵심 누락, 오류, 보완 필요, 담당자 확인 필요 항목"],
  "findings": [
    {
      "type": "정상 | 누락 | 오류 | 보완 필요 | 담당자 확인 필요",
      "title": "검토 제목",
      "detail": "문서명, 읽힌 값, 비교 결과, 조치사항",
      "related_documents": ["관련 문서"]
    }
  ],
  "document_summary": [
    {
      "document_name": "문서 종류",
      "file_name": "파일명",
      "business_code": "읽힌 사업코드 또는 확인불가",
      "date": "읽힌 날짜 또는 확인불가",
      "amount": "읽힌 금액 또는 확인불가",
      "receiver": "읽힌 수신처 또는 확인불가",
      "notes": "문서별 검토 메모"
    }
  ],
  "caution": "최종 지급 승인 전 담당자가 원본 문서를 확인해야 합니다."
}
`;

    const openaiResponse = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4.1",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: prompt
                },
                ...inputFiles
              ]
            }
          ],
          text: {
            format: {
              type: "json_object"
            }
          }
        })
      }
    );

    if (!openaiResponse.ok) {
      throw new Error(await openaiResponse.text());
    }

    const openaiData = await openaiResponse.json();

    let result;

    try {
      result = normalizeResult(
        JSON.parse(openaiData.output_text || "{}")
      );
    } catch {
      result = fallbackResult(
        "AI 검토 응답 형식을 해석하지 못했습니다. 담당자 원본 확인이 필요합니다."
      );
    }

    await supabase
      .from("expense_requests")
      .update({
        status: result.status,
        ai_result: result,
        updated_at: new Date().toISOString()
      })
      .eq("id", requestId);

    return json(result);
  } catch (error) {
    console.error(error);

    return json(
      {
        error: "AI 검토 처리 중 오류가 발생했습니다.",
        detail: error.message
      },
      500
    );
  }
}
